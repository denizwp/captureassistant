import { BrowserWindow, ipcMain, screen } from 'electron'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { INITIAL_STATE } from '@shared/state'
import type { SettingsStore } from './store'

/**
 * Every renderer call is a request/response `invoke`. State travels the other
 * way as a push on change — there is no polling channel anywhere in this app.
 */
export function registerIpc(store: SettingsStore): void {
  ipcMain.handle('settings:get', () => store.get())

  ipcMain.handle('settings:set', (_e, patch: DeepPartial<Settings>) => {
    const next = store.update(patch)
    broadcast('settings', next)
    return next
  })

  // Wired to the supervisor in a later step; the contract is in place so the
  // renderer can be built against it now.
  ipcMain.handle('state:get', () => INITIAL_STATE)

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
