import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { logPath, write } from './log'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { Clip } from '@shared/state'
import type { SettingsStore } from './store'
import type { AudioEngine } from './audio'
import type { SupervisorHost } from './supervisor'
import { durationFor, thumbnailFor } from './thumbnails'

/*
 * These all go through the same handlers the tray and the hotkeys use. Having a
 * second copy here is what let the window and the overlay drift out of step with
 * them — same button, different behaviour depending on where it was pressed.
 */
export interface IpcHooks {
  onSettingsChanged?: () => void
  toggleReplay?: (enabled: boolean) => Promise<void>
  toggleRecording?: () => Promise<void>
  saveReplay?: () => void
  toggleMic?: () => void
  openSettings?: () => void
  closeHud?: () => void
}

export function registerIpc(
  store: SettingsStore,
  audio: AudioEngine,
  supervisor: SupervisorHost,
  hooks: IpcHooks = {}
): void {
  const onSettingsChanged = hooks.onSettingsChanged ?? ((): void => undefined)
  const outputDir = (): string => store.get().output.dir ?? defaultOutputDir()

  applyLaunchAtLogin(store.get().app.launchAtLogin)

  supervisor.on('state', (state) => broadcast('state', state))
  supervisor.on('toast', (toast) => broadcast('toast', toast))
  audio.on('levels', (levels) => {
    const payload = levels as { system: number; mic: number }
    broadcast('levels', { ...payload, system: audio.takeSystemPeak() })
  })
  audio.on('status', (payload: { running: boolean; error?: string }) => {
    if (payload.error) {
      broadcast('toast', { kind: 'warning', message: `Ses yakalanamadı: ${payload.error}` })
    }
  })
  supervisor.on('clip', () => void listClips(outputDir()).then((c) => broadcast('clips', c)))

  ipcMain.handle('settings:get', () => store.get())

  ipcMain.handle('settings:set', (_e, patch: DeepPartial<Settings>) => {
    const next = store.update(patch)
    broadcast('settings', next)
    supervisor.updateSettings(next)
    onSettingsChanged()
    if (patch.app?.launchAtLogin !== undefined) {
      applyLaunchAtLogin(next.app.launchAtLogin)
    }
    if (patch.audio) {
      audio.setGains(
        next.audio.systemEnabled ? next.audio.systemGain : 0,
        next.audio.micEnabled ? next.audio.micGain : 0
      )
    }
    return next
  })

  ipcMain.handle('state:get', () => supervisor.getState())

  ipcMain.handle('capture:toggle-replay', (_e, enabled: boolean) => hooks.toggleReplay?.(enabled))
  ipcMain.handle('capture:toggle-record', () => hooks.toggleRecording?.())
  ipcMain.handle('capture:save-replay', () => hooks.saveReplay?.())
  ipcMain.handle('capture:toggle-mic', () => hooks.toggleMic?.())

  ipcMain.on('hud:open-settings', () => hooks.openSettings?.())
  ipcMain.on('hud:close', () => hooks.closeHud?.())

  ipcMain.handle('audio:meter', (_e, enabled: boolean) => audio.setMetering(enabled))


  ipcMain.handle('audio:devices', () => {
    audio.refreshDevices()
    return audio.getDevices()
  })

  ipcMain.handle('dialog:choose-directory', async (e, current: string | null) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      ...(current ? { defaultPath: current } : {})
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('clips:list', () => listClips(outputDir()))

  ipcMain.handle('clips:meta', async (_e, path: string, mtimeMs: number) => {
    const [thumb, durationSec] = await Promise.all([
      thumbnailFor(path, mtimeMs),
      durationFor(path, mtimeMs)
    ])
    return {
      thumbnail: thumb ? `file://${thumb.replace(/\\/g, '/')}` : null,
      durationSec
    }
  })

  ipcMain.handle('clips:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('clips:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('clips:delete', async (_e, path: string) => {
    // Recycle rather than unlink: one stray click should not cost a clip that
    // cannot be made again.
    await shell.trashItem(path).catch(() => rm(path, { force: true }))
    broadcast('clips', await listClips(outputDir()))
  })
  ipcMain.handle('clips:reveal-folder', () => shell.openPath(outputDir()))

  // Reveals rather than opens: the point is to let someone attach the file to a
  // report, and Explorer hands it over with one drag.
  ipcMain.handle('logs:reveal', async () => {
    const path = logPath()
    if (!existsSync(path)) {
      write('log requested before anything was written')
    }
    shell.showItemInFolder(path)
  })

  ipcMain.handle('monitors:list', () =>
    screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || `Ekran ${i + 1}`,
      width: d.size.width,
      height: d.size.height
    }))
  )

  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}

function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ['--hidden']
  })
}

function defaultOutputDir(): string {
  return join(app.getPath('videos'), 'Capture Assistant')
}

async function listClips(dir: string): Promise<Clip[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const clips: Clip[] = []

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.mp4') continue
    const path = join(dir, entry.name)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    clips.push({
      id: path,
      path,
      name: basename(entry.name, extname(entry.name)),
      durationSec: 0,
      sizeBytes: info.size,
      createdAt: info.mtimeMs,
      thumbnailPath: null
    })
  }

  return clips.sort((a, b) => b.createdAt - a.createdAt)
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
    }
  }
}
