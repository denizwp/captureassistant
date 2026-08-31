import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { SettingsStore } from './store'

const preload = join(__dirname, '../preload/index.js')

/** electron-vite serves renderers from a dev server; in production they are
 *  static files next to the main bundle. */
function loadRenderer(win: BrowserWindow, page: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/${page}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer', page))
  }
}

export function createMainWindow(store: SettingsStore): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: store.get().app.theme === 'light' ? '#fbfbfb' : '#1a1a1a',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'index.html')
  return win
}
