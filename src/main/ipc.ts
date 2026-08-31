import { BrowserWindow, ipcMain, screen } from 'electron'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { INITIAL_STATE, type SupervisorState } from '@shared/state'
import type { SettingsStore } from './store'

/**
 * Every renderer call is a request/response `invoke`. State travels the other
 * way as a push on change — there is no polling channel anywhere in this app.
 */
const ENGINE_PENDING = 'Kayıt motoru henüz bağlı değil.'

let state: SupervisorState = INITIAL_STATE

function setState(patch: Partial<SupervisorState>): void {
  state = { ...state, ...patch }
  broadcast('state', state)
}

export function registerIpc(store: SettingsStore): void {
  ipcMain.handle('settings:get', () => store.get())

  ipcMain.handle('settings:set', (_e, patch: DeepPartial<Settings>) => {
    const next = store.update(patch)
    broadcast('settings', next)
    return next
  })

  ipcMain.handle('state:get', () => state)

  /**
   * Arming the buffer is a real, persisted setting, so it takes effect now.
   * The supervisor will read it when it lands; until then the state we publish
   * reflects intent rather than a running encoder.
   */
  ipcMain.handle('capture:toggle-replay', (_e, enabled: boolean) => {
    broadcast('settings', store.update({ replay: { enabled } }))
    setState({ state: enabled ? 'armed' : 'idle' })
  })

  // These two need the encoder. Rather than fake a recording, say so plainly.
  ipcMain.handle('capture:toggle-record', () => {
    broadcast('toast', { kind: 'warning', message: ENGINE_PENDING })
  })

  ipcMain.handle('capture:save-replay', () => {
    broadcast('toast', { kind: 'warning', message: ENGINE_PENDING })
  })

  ipcMain.handle('monitors:list', () =>
    screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || `Display ${i + 1}`,
      width: d.size.width,
      height: d.size.height
    }))
  )

  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
