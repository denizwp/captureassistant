import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ArchiveEntry, ChatKind, ChatLine } from '@shared/chat'
import type { SettingsStore } from '../store'
import type { ChatCapture } from './index'
import { listArchive, readArchive } from './archive'
import { classify, resolveMoment, splitTimestamp } from './classify'
import { exportHtml, exportText, type ExportLine } from './export'

export function chatArchiveDir(store: SettingsStore): string {
  return store.get().chat.archiveDir ?? join(app.getPath('documents'), 'Capture Assistant Sohbet')
}

/*
 * An archived line is plain text on disk, so the kind is worked out the same
 * way it was when it was captured rather than being stored alongside it.
 */
function reviveLine(text: string, runs: ChatLine['runs'], index: number): ChatLine {
  const marker = /^---\s.*\s---$/.test(text.trim())
  const split = splitTimestamp(text)
  const shifted = runs
    .map((run) => ({ ...run, start: run.start - split.removed }))
    .filter((run) => run.start + run.length > 0)
    .map((run) => (run.start < 0 ? { ...run, length: run.length + run.start, start: 0 } : run))

  return {
    id: `a${index}`,
    // Only the time of day is ever shown from this, so the date it lands on
    // does not matter — the file name already says which day it was.
    at: marker ? 0 : resolveMoment(Date.now(), split.stamp),
    text: marker ? text : split.body,
    raw: text,
    kind: marker ? 'system' : classify(split.body),
    runs: marker ? [] : shifted
  }
}

/*
 * Colour runs are always kept against the line without its clock, since that is
 * what is drawn on screen. Putting the clock back makes the text longer, so
 * every run has to slide forward by exactly what was added.
 */
function runsWithClock(line: ChatLine): ChatLine['runs'] {
  const added = line.raw.length - line.text.length
  if (added <= 0) return line.runs
  return line.runs.map((run) => ({ ...run, start: run.start + added }))
}

function matches(line: ChatLine, kinds: ChatKind[], query: string): boolean {
  if (!kinds.includes(line.kind)) return false
  if (!query) return true
  return line.text.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr'))
}

/*
 * The chat covering a clip, written next to it under the same name. The window
 * is taken from the clip's own length, so it lines up with what was recorded
 * rather than with when the file happened to finish being written.
 */
export async function writeChatBeside(
  lines: ChatLine[],
  clipPath: string,
  durationSec: number,
  endedAt?: number,
  withClock = true
): Promise<string | null> {
  const until = endedAt ?? Date.now()
  const since = until - durationSec * 1000
  const covered = lines.filter((line) => line.at >= since && line.at <= until)
  if (covered.length === 0) return null

  const target = `${clipPath.slice(0, -4)}.txt`
  await exportText(
    target,
    covered.map((line) => ({
      text: withClock ? line.raw : line.text,
      runs: withClock ? runsWithClock(line) : line.runs,
      kind: line.kind
    }))
  )
  return target
}

export function registerChatIpc(store: SettingsStore, chat: ChatCapture): void {
  ipcMain.handle('chat:status', () => chat.getStatus())
  ipcMain.handle('chat:lines', () => chat.getLines())

  ipcMain.handle('chat:archive-list', async (): Promise<ArchiveEntry[]> => {
    const root = chatArchiveDir(store)
    await mkdir(root, { recursive: true }).catch(() => undefined)
    return listArchive(root)
  })

  ipcMain.handle('chat:archive-read', async (_e, path: string): Promise<ChatLine[]> => {
    const lines = await readArchive(path)
    return lines.map((line, index) => reviveLine(line.text, line.runs, index))
  })

  ipcMain.handle('chat:reveal-folder', async () => {
    const root = chatArchiveDir(store)
    await mkdir(root, { recursive: true }).catch(() => undefined)
    await shell.openPath(root)
  })

  ipcMain.handle(
    'chat:export',
    async (
      event,
      payload: { source: 'live' | string; format: 'txt' | 'html'; kinds: ChatKind[]; query: string }
    ): Promise<string | null> => {
      const live = payload.source === 'live'
      const lines: ChatLine[] = live
        ? chat.getLines()
        : (await readArchive(payload.source)).map((line, index) =>
            reviveLine(line.text, line.runs, index)
          )

      /*
       * What is exported is what is on screen: the same filters, the same
       * search. The archive on disk is never rewritten by this.
       */
      const withClock = store.get().chat.showTimestamps
      const kept: ExportLine[] = lines
        .filter((line) => matches(line, payload.kinds, payload.query))
        .map((line) => ({
          // The clock is part of the line on disk; whether it comes out again is
          // the same choice that governs whether it is on screen.
          text: withClock ? line.raw : line.text,
          runs: withClock ? runsWithClock(line) : line.runs,
          kind: line.kind
        }))

      if (kept.length === 0) return null

      const stamp = new Date()
      const pad = (value: number): string => String(value).padStart(2, '0')
      const name = live
        ? `Sohbet ${stamp.getFullYear()}.${pad(stamp.getMonth() + 1)}.${pad(stamp.getDate())}` +
          ` - ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}`
        : basename(payload.source, '.txt')

      // Where it goes is the user's call. Dropping it into Downloads meant
      // hunting for it afterwards, and there is nowhere sensible to guess.
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: 'Sohbeti kaydet',
        defaultPath: join(app.getPath('documents'), `${name}.${payload.format}`),
        filters:
          payload.format === 'txt'
            ? [{ name: 'Metin dosyası', extensions: ['txt'] }]
            : [{ name: 'Web sayfası', extensions: ['html'] }]
      }
      const chosen = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (chosen.canceled || !chosen.filePath) return null

      const target = chosen.filePath
      if (payload.format === 'txt') await exportText(target, kept)
      else await exportHtml(target, name, kept)
      return target
    }
  )
}
