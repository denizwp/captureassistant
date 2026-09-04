import { EventEmitter } from 'node:events'
import type { ChatLine, ChatStatus } from '@shared/chat'
import { INITIAL_CHAT_STATUS } from '@shared/chat'
import { DevToolsPage } from './cdp'
import { READ_CHAT, READ_SERVER, type RawLine, type ServerHint } from './read'
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

    const server = hint?.name?.trim() || address
    const rows = (await page.evaluate<RawLine[]>(READ_CHAT)) ?? []
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

  private async connect(): Promise<void> {
    await this.disconnect(null)
    const targets = await DevToolsPage.listPages()
    if (targets.length === 0) throw new Error('oyun arayüzü bulunamadı')

    /*
     * Several frames are listening and only one of them draws chat. Rather than
     * matching on a url that a game update could rename, each is asked for the
     * chat and the first that answers with rows is kept.
     */
    let fallback: DevToolsPage | null = null
    for (const target of targets) {
      const page = new DevToolsPage()
      try {
        await page.attach(target)
        const rows = await page.evaluate<RawLine[]>(READ_CHAT)
        if (rows && rows.length > 0) {
          this.page = page
          return
        }
        // Empty chat is normal on a quiet server, so keep the first frame that
        // at least answered as a fallback rather than discarding everything.
        if (rows && !fallback) fallback = page
        else page.close()
      } catch {
        page.close()
      }
    }

    if (fallback) {
      this.page = fallback
      return
    }
    throw new Error('sohbet penceresi bulunamadı')
  }

  private async disconnect(marker: string | null): Promise<void> {
    this.page?.close()
    this.page = null
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
