import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SettingsStore } from './store'

/** Set once the user has actually asked to quit, so the close handler stops
 *  intercepting. Without it "Çıkış" would just hide the window forever. */
let quitting = false

export function beginQuit(): void {
  quitting = true
}

const preload = join(__dirname, '../preload/index.js')

/** Packaged builds ship `resources/` next to the app; in dev it sits at the
 *  project root, two levels up from the bundled main process. */
function resource(name: string): string {
  const packaged = join(process.resourcesPath, name)
  return existsSync(packaged) ? packaged : join(__dirname, '../../resources', name)
}

// .ico carries every size Windows asks for; a lone PNG gets scaled badly in
// the taskbar and alt-tab.
const icon = resource('icon.ico')

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

export function createMainWindow(
  store: SettingsStore,
  options: { show?: boolean } = {}
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    icon,
    backgroundColor: store.get().app.theme === 'light' ? '#fbfbfb' : '#1a1a1a',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (options.show !== false) win.once('ready-to-show', () => win.show())

  // Closing the window is not closing the app: the replay buffer has to keep
  // running, which is the entire point of a background recorder.
  win.on('close', (event) => {
    if (quitting || !store.get().app.minimizeToTray) return
    event.preventDefault()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'index.html')
  return win
}
