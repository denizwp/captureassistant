import { EventEmitter } from 'node:events'
import type { ChatLine, ChatStatus } from '@shared/chat'
import { INITIAL_CHAT_STATUS } from '@shared/chat'
import { DevToolsPage } from './cdp'
import {
  FIND_CHAT,
  READ_SERVER,
  readChat,
  resolveServerName,
  type ChatLocation,
  type RawLine,
  type ServerHint
} from './read'
import { classify, resolveMoment, splitTimestamp } from './classify'
import { ChatArchive, newLinesOnly, type ArchivedLine } from './archive'

/*
 * Once a second. The game keeps far more than a second of chat on screen, so
 * this cannot outrun the window and miss lines, and it costs one small query
 * against an interface that is already running.
 */
const POLL_MS = 1000
/* Backing off after a failure, so a closed game is not hammered. */
const RETRY_MS = 5000
/* What the live view holds. The archive on disk is the long memory. */
const LIVE_LIMIT = 2000

export class ChatCapture extends EventEmitter {
  private page: DevToolsPage | null = null
  private timer: NodeJS.Timeout | null = null
  private running = false
  private status: ChatStatus = { ...INITIAL_CHAT_STATUS }
  private lines: ChatLine[] = []
  private lastVisible: string[] = []
  private archive: ChatArchive
  private nextId = 1
  private sawServer = ''
  private readonly names = new Map<string, { name: string; retryAt: number }>()
  /* Where chat was found: which frame's world, and the selector inside it. */
  private where: string | null = null
  private world: number | undefined = undefined

  constructor(root: string) {
    super()
    this.archive = new ChatArchive(root)
  }

  getStatus(): ChatStatus {
    return this.status
  }

  getLines(): ChatLine[] {
    return this.lines
  }

  setRoot(root: string): void {
    this.archive.setRoot(root)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.publish({ state: 'waiting', error: null })
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.disconnect('Sohbet takibi kapatıldı.')
    this.publish({ ...INITIAL_CHAT_STATUS })
  }

  private schedule(delay: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), delay)
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    try {
      await this.poll()
      this.schedule(POLL_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.disconnect('Oyunla bağlantı kesildi.')
      this.publish({
        state: this.running ? 'waiting' : 'off',
        error: message,
        serverName: null,
        serverAddress: null
      })
      this.schedule(RETRY_MS)
    }
  }

  private async poll(): Promise<void> {
    if (!this.page?.connected) await this.connect()
    const page = this.page
    if (!page) throw new Error('oyun arayüzüne bağlanılamadı')

    const hint = await page.evaluate<ServerHint>(READ_SERVER)
    const address = hint?.address?.trim() ?? ''
    if (!address) {
      // The game is up but sitting on the menu; there is nothing to file yet.
      this.publish({ state: 'waiting', serverName: null, serverAddress: null, error: null })
      return
    }

    const server = hint?.name?.trim() || (await this.nameFor(address))

    /*
     * A null answer means the element that was found is gone — the chat was
     * rebuilt, or the interface reloaded. Look again rather than sitting on a
     * path that will never match anything.
     */
    let rows = this.where
      ? await page.evaluate<RawLine[]>(readChat(this.where), this.world)
      : null
    if (rows === null) {
      await this.connect()
      rows = this.where
        ? ((await this.page?.evaluate<RawLine[]>(readChat(this.where), this.world)) ?? [])
        : []
    }
    const at = new Date()

    if (server !== this.sawServer) {
      this.sawServer = server
      this.lastVisible = []
      const marker = await this.archive.open(server, at)
      if (marker) await this.archive.mark(marker, at)
      await this.archive.mark(`Bağlanıldı: ${server}`, at)
      // After a restart the file already holds part of what is on screen, so
      // line up against its tail instead of writing all of it again.
      this.lastVisible = await this.archive.tail(200)
    } else {
      const marker = await this.archive.open(server, at)
      if (marker) await this.archive.mark(marker, at)
    }

    const visible = rows.map((row) => row.t)
    const fresh = newLinesOnly(this.lastVisible, visible)
    this.lastVisible = visible.slice(-200)

    if (fresh.length > 0) {
      const startsAt = visible.length - fresh.length
      const written: ArchivedLine[] = []
      for (let i = 0; i < fresh.length; i++) {
        const row = rows[startsAt + i]
        if (!row) continue
        written.push({ text: row.t, runs: toRuns(row) })
        this.lines.push(this.toLine(row, at))
      }
      await this.archive.append(written)
      if (this.lines.length > LIVE_LIMIT) this.lines = this.lines.slice(-LIVE_LIMIT)
      this.emit('lines', this.lines)
    }

    this.publish({
      state: 'connected',
      serverName: server,
      serverAddress: address,
      archiveFile: this.archive.currentFile,
      capturedToday: this.status.capturedToday + fresh.length,
      error: null
    })
  }

  private toLine(row: RawLine, seenAt: Date): ChatLine {
    const split = splitTimestamp(row.t)
    const runs = toRuns(row)
      .map((run) => ({
        start: run.start - split.removed,
        length: run.length,
        color: run.color
      }))
      .filter((run) => run.start + run.length > 0)
      .map((run) =>
        run.start < 0 ? { ...run, length: run.length + run.start, start: 0 } : run
      )

    return {
      id: `l${this.nextId++}`,
      at: resolveMoment(seenAt.getTime(), split.stamp),
      text: split.body,
      kind: classify(split.body),
      runs
    }
  }

  /*
   * Asked once per address and kept. A server that does not answer falls back
   * to its address, and is asked again after a while rather than being written
   * off — the endpoint is often just slow to come up right after connecting.
   */
  private async nameFor(address: string): Promise<string> {
    const known = this.names.get(address)
    if (known && (known.name || Date.now() < known.retryAt)) return known.name || address

    const name = await resolveServerName(address).catch(() => null)
    this.names.set(address, { name: name ?? '', retryAt: Date.now() + 60_000 })
    return name ?? address
  }

  /*
   * Several frames are listening and only one of them draws chat. Each is asked
   * to look for something chat-shaped inside itself, and whichever finds the
   * most convincing one is kept along with the path it found, so every later
   * read is a single lookup.
   */
  private async connect(): Promise<void> {
    await this.disconnect(null)
    const targets = await DevToolsPage.listPages()
    if (targets.length === 0) throw new Error('oyun arayüzü bulunamadı')

    let best: { page: DevToolsPage; world: number; found: ChatLocation } | null = null
    const looked: string[] = []

    for (const target of targets) {
      const page = new DevToolsPage()
      try {
        await page.attach(target)
        const worlds = await page.findWorlds()
        // The outer document counts too: a server that draws chat itself rather
        // than through a resource has it there.
        const ids = [undefined, ...worlds.map((world) => world.id)]

        for (const id of ids) {
          const found = await page.evaluate<ChatLocation>(FIND_CHAT, id).catch(() => null)
          const where = worlds.find((world) => world.id === id)?.origin ?? 'kök'
          if (!found?.path) continue
          looked.push(`${where}:${found.rows}`)
          if (!best || found.rows > best.found.rows) {
            if (best && best.page !== page) best.page.close()
            best = { page, world: id ?? -1, found }
          }
        }
        if (best?.page !== page) page.close()
      } catch {
        page.close()
      }
    }

    if (!best) throw new Error('sohbet penceresi bulunamadı')
    this.page = best.page
    this.world = best.world < 0 ? undefined : best.world
    this.where = best.found.path
    // Written once per attach. When someone reports an empty chat this line is
    // what says whether nothing was found, or the wrong thing was.
    this.emit(
      'note',
      `sohbet bulundu: ${best.found.path} (${best.found.rows} satır) — ` +
        `${best.found.sample} | bakılanlar: ${looked.join(', ') || 'yok'}`
    )
  }

  private async disconnect(marker: string | null): Promise<void> {
    this.page?.close()
    this.page = null
    this.where = null
    this.world = undefined
    if (marker && this.sawServer) {
      await this.archive.mark(marker, new Date()).catch(() => undefined)
    }
    this.sawServer = ''
    this.lastVisible = []
  }

  private publish(next: Partial<ChatStatus>): void {
    this.status = { ...this.status, ...next }
    this.emit('status', this.status)
  }
}

function toRuns(row: RawLine): { start: number; length: number; color: string }[] {
  return (row.r ?? []).map((run) => ({ start: run.s, length: run.n, color: run.c }))
}
