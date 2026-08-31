import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { Clip } from '@shared/state'
import type { SettingsStore } from './store'
import type { AudioEngine } from './audio'
import type { SupervisorHost } from './supervisor'
import { thumbnailFor } from './thumbnails'

/**
 * Every renderer call is a request/response `invoke`. State travels the other
 * way as a push on change — there is no polling channel anywhere in this app.
 */
export function registerIpc(
  store: SettingsStore,
  audio: AudioEngine,
  supervisor: SupervisorHost,
  onSettingsChanged: () => void = () => undefined
): void {
  const outputDir = (): string => store.get().output.dir ?? defaultOutputDir()

  // Reapply on boot: the user may have toggled it, then reinstalled, or the
  // registry entry may have been cleared by something else.
  applyLaunchAtLogin(store.get().app.launchAtLogin)

  supervisor.on('state', (state) => broadcast('state', state))
  supervisor.on('toast', (toast) => broadcast('toast', toast))
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
      // Live change — restarting the capture page mid-recording would break the
      // ring, so gains move instead.
      audio.setGains(
        next.audio.systemEnabled ? next.audio.systemGain : 0,
        next.audio.micEnabled ? next.audio.micGain : 0
      )
    }
    return next
  })

  ipcMain.handle('state:get', () => supervisor.getState())

  ipcMain.handle('capture:toggle-replay', async (_e, enabled: boolean) => {
    const next = store.update({ replay: { enabled } })
    broadcast('settings', next)
    if (enabled) await audio.start(next.audio)
    else audio.stop()
    supervisor.arm(enabled)
  })

  ipcMain.handle('capture:toggle-record', async () => {
    const recording = supervisor.getState().state === 'recording'
    if (!recording) await audio.start(store.get().audio)
    supervisor.record(!recording)
  })

  ipcMain.handle('capture:save-replay', () => supervisor.saveReplay())

  ipcMain.handle('audio:devices', () => {
    audio.refreshDevices()
    return audio.getDevices()
  })

  ipcMain.handle('clips:list', () => listClips(outputDir()))

  // Generated on demand rather than during the listing, so the gallery paints
  // immediately and fills in as frames arrive.
  ipcMain.handle('clips:thumbnail', async (_e, path: string, mtimeMs: number) => {
    const thumb = await thumbnailFor(path, mtimeMs)
    return thumb ? `file://${thumb.replace(/\\/g, '/')}` : null
  })

  ipcMain.handle('clips:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('clips:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('clips:delete', async (_e, path: string) => {
    await rm(path, { force: true })
    broadcast('clips', await listClips(outputDir()))
  })
  ipcMain.handle('clips:reveal-folder', () => shell.openPath(outputDir()))

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

/** Starts hidden — an autostarted recorder that throws a window in your face
 *  on every boot is a recorder people uninstall. */
function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ['--hidden']
  })
}

function defaultOutputDir(): string {
  return join(app.getPath('videos'), 'Capture Assistant')
}

/** Reads the output folder rather than keeping a database. The folder is the
 *  source of truth: people move, rename and delete clips outside the app, and
 *  an index would just drift. */
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
      // Filled in by a probe pass later; the list must not block on ffprobe.
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
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
