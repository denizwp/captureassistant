import { app, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ArchiveEntry, ChatKind, ChatLine } from '@shared/chat'
import type { SettingsStore } from '../store'
import type { ChatCapture } from './index'
import { listArchive, readArchive } from './archive'
import { classify, splitTimestamp } from './classify'
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
    at: 0,
    text: marker ? text : split.body,
    kind: marker ? 'system' : classify(split.body),
    runs: marker ? [] : shifted
  }
}

function matches(line: ChatLine, kinds: ChatKind[], query: string): boolean {
  if (!kinds.includes(line.kind)) return false
  if (!query) return true
  return line.text.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr'))
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
      _e,
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
      const kept: ExportLine[] = lines
        .filter((line) => matches(line, payload.kinds, payload.query))
        .map((line) => ({ text: line.text, runs: line.runs, kind: line.kind }))

      if (kept.length === 0) return null

      const stamp = new Date()
      const pad = (value: number): string => String(value).padStart(2, '0')
      const name = live
        ? `Sohbet ${stamp.getFullYear()}.${pad(stamp.getMonth() + 1)}.${pad(stamp.getDate())}` +
          ` - ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}`
        : basename(payload.source, '.txt')

      const target = join(app.getPath('downloads'), `${name}.${payload.format}`)
      if (payload.format === 'txt') await exportText(target, kept)
      else await exportHtml(target, name, kept)
      shell.showItemInFolder(target)
      return target
    }
  )
}
