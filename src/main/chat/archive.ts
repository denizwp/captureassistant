import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArchiveEntry, ChatColorRun } from '@shared/chat'

const MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
]

/* Windows will not take these in a file name, and server names are arbitrary. */
function safe(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'Bilinmeyen'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function folderFor(root: string, day: Date): string {
  return join(root, String(day.getFullYear()), `${pad(day.getMonth() + 1)} - ${MONTHS[day.getMonth()]}`)
}

export function fileFor(root: string, server: string, day: Date): string {
  const stamp = `${pad(day.getDate())}-${MONTHS[day.getMonth()]}-${day.getFullYear()}`
  return join(folderFor(root, day), `Sohbet [${safe(server)}] [${stamp}].txt`)
}

/* Colours live beside the log, never inside it, so the log stays plain text. */
export function colorFileFor(logPath: string): string {
  return `${logPath.slice(0, -4)}.renkler.jsonl`
}

export interface ArchivedLine {
  text: string
  runs: ChatColorRun[]
}

/*
 * How much of what is on screen now was already written.
 *
 * The game only keeps the last handful of lines on screen, so every read hands
 * back a window that mostly repeats the previous one. The new part is whatever
 * follows the longest run of previous lines that still matches the start of the
 * current ones. Longest first, because a short accidental match — two people
 * greeting each other the same way — would otherwise re-append lines that are
 * already in the file.
 */
export function newLinesOnly(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current
  const most = Math.min(previous.length, current.length)
  for (let size = most; size > 0; size--) {
    let same = true
    for (let i = 0; i < size; i++) {
      if (previous[previous.length - size + i] !== current[i]) {
        same = false
        break
      }
    }
    if (same) return current.slice(size)
  }
  /*
   * Nothing lined up. Either the chat was cleared or more was said than the
   * window can hold between two reads, and in both cases every visible line is
   * genuinely unwritten as far as this file is concerned.
   */
  return current
}

export class ChatArchive {
  private path: string | null = null
  private day = ''
  private server = ''

  constructor(private root: string) {}

  get currentFile(): string | null {
    return this.path
  }

  setRoot(root: string): void {
    if (root === this.root) return
    this.root = root
    this.path = null
  }

  /*
   * Points the archive at the file for this server and this calendar day,
   * opening a new one when either changes. Returns a marker to write when the
   * file changed under us, so the log says why it starts where it does.
   */
  async open(server: string, at: Date): Promise<string | null> {
    const day = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`
    if (this.path && this.day === day && this.server === server) return null

    const rolled = this.path !== null && this.server === server && this.day !== day
    const switched = this.path !== null && this.server !== server

    await mkdir(folderFor(this.root, at), { recursive: true })
    this.path = fileFor(this.root, server, at)
    this.day = day
    this.server = server

    if (rolled) return 'Gün değişti, kayda yeni dosyada devam ediliyor.'
    if (switched) return `Sunucu değişti: ${server}.`
    return null
  }

  async append(lines: ArchivedLine[]): Promise<void> {
    const path = this.path
    if (!path || lines.length === 0) return
    await appendFile(path, lines.map((line) => line.text).join('\n') + '\n', 'utf8')
    await appendFile(
      colorFileFor(path),
      lines.map((line) => JSON.stringify(line.runs)).join('\n') + '\n',
      'utf8'
    )
  }

  /* A dated line of its own, for logins, disconnects and day changes. */
  async mark(text: string, at: Date): Promise<void> {
    const stamp = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    await this.append([{ text: `--- [${stamp}] ${text} ---`, runs: [] }])
  }

  /* The tail of the file, used to line up with what is on screen after a restart. */
  async tail(count: number): Promise<string[]> {
    if (!this.path) return []
    const text = await readFile(this.path, 'utf8').catch(() => '')
    if (!text) return []
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-count)
  }
}

const NAME = /^Sohbet \[(.+)\] \[(\d{2})-(.+)-(\d{4})\]\.txt$/

export async function listArchive(root: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const years = await readdir(root, { withFileTypes: true }).catch(() => [])

  for (const year of years) {
    if (!year.isDirectory()) continue
    const months = await readdir(join(root, year.name), { withFileTypes: true }).catch(() => [])
    for (const month of months) {
      if (!month.isDirectory()) continue
      const dir = join(root, year.name, month.name)
      const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile()) continue
        const match = NAME.exec(file.name)
        if (!match) continue
        const path = join(dir, file.name)
        const info = await stat(path).catch(() => null)
        if (!info) continue
        const monthIndex = MONTHS.indexOf(match[3] ?? '')
        entries.push({
          path,
          server: match[1] ?? '',
          day: new Date(
            Number(match[4]),
            monthIndex < 0 ? 0 : monthIndex,
            Number(match[2])
          ).getTime(),
          sizeBytes: info.size,
          lines: 0
        })
      }
    }
  }

  return entries.sort((a, b) => b.day - a.day || a.server.localeCompare(b.server, 'tr'))
}

export async function readArchive(path: string): Promise<ArchivedLine[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (!text) return []
  const lines = text.split('\n').filter((line) => line.length > 0)

  // Colours are optional: an archive copied somewhere else, or one written
  // before they were recorded, still opens — just without them.
  const colorText = await readFile(colorFileFor(path), 'utf8').catch(() => '')
  const colorLines = colorText ? colorText.split('\n').filter(Boolean) : []
  const aligned = colorLines.length === lines.length

  return lines.map((line, index) => {
    let runs: ChatColorRun[] = []
    if (aligned) {
      try {
        runs = JSON.parse(colorLines[index] ?? '[]') as ChatColorRun[]
      } catch {
        runs = []
      }
    }
    return { text: line, runs }
  })
}
