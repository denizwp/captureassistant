import { BrowserWindow, screen } from 'electron'
import type { AppSettings } from '@shared/settings'
import { join } from 'node:path'

const WIDTH = 760
const HEIGHT = 520

const BASE_COLOR: Record<AppSettings['theme'], string> = {
  dark: '#0b0b0b',
  light: '#fbfbfb'
}

export class Hud {
  private window: BrowserWindow | null = null
  private hiddenAt = 0
  private ready = false

  private theme: AppSettings['theme'] = 'dark'

  constructor(private readonly preload = join(__dirname, '../preload/hud.js')) {}

  create(theme: AppSettings['theme'] = this.theme): void {
    this.theme = theme
    if (this.window && !this.window.isDestroyed()) return

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      backgroundColor: BASE_COLOR[theme],

      roundedCorners: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    this.window = win

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)

    win.on('blur', () => this.hide())

    win.once('ready-to-show', () => {
      this.ready = true
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    void (devUrl
      ? win.loadURL(`${devUrl}/hud.html`)
      : win.loadFile(join(__dirname, '../renderer/hud.html')))
  }

  private center(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    win.setBounds({
      x: Math.round(bounds.x + (bounds.width - WIDTH) / 2),
      y: Math.round(bounds.y + (bounds.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT
    })
  }

  get visible(): boolean {
    const win = this.window
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  toggle(): void {
    if (this.visible || Date.now() - this.hiddenAt < 400) this.hide()
    else this.show()
  }

  show(): void {
    this.create()
    const win = this.window
    if (!win || win.isDestroyed()) return

    if (!this.ready) {
      win.once('ready-to-show', () => this.show())
      return
    }

    this.center()
    win.showInactive()
    win.focus()

    win.setAlwaysOnTop(true, 'screen-saver')
  }

  hide(): void {
    const win = this.window
    if (win && !win.isDestroyed() && win.isVisible()) {
      this.hiddenAt = Date.now()
      win.hide()
    }
  }

  setTheme(theme: AppSettings['theme']): void {
    if (theme === this.theme) return
    this.theme = theme
    this.window?.setBackgroundColor(BASE_COLOR[theme])
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
  }
}
