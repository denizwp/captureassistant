import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SettingsStore } from './store'

let quitting = false

export function beginQuit(): void {
  quitting = true
}

const preload = join(__dirname, '../preload/index.js')

function resource(name: string): string {
  const packaged = join(process.resourcesPath, name)
  return existsSync(packaged) ? packaged : join(__dirname, '../../resources', name)
}

const icon = resource('icon.ico')

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
