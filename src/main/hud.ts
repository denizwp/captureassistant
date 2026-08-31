import { BrowserWindow, screen } from 'electron'
import type { AppSettings } from '@shared/settings'
import { join } from 'node:path'

const WIDTH = 760
const HEIGHT = 520

/*
 * Exactly the colour the panel renders as, measured from a screenshot.
 *
 * Hiding a window lets Chromium release its compositor surface, so on show
 * there are a few frames of nothing but this colour before the content is
 * rastered again. Any mismatch reads as a flash. Acrylic made it worse: the
 * material itself is mid grey, and the panel over it came out at rgb(11,11,11)
 * anyway, so the blur was contributing nothing but that flash.
 */
const BASE_COLOR: Record<AppSettings['theme'], string> = {
  dark: '#0b0b0b',
  light: '#fbfbfb'
}

/*
 * The in-game panel, opened with a hotkey.
 *
 * This is an always-on-top window, not an injected overlay. Drawing inside a
 * game means hooking its D3D swapchain, which is exactly what anti-cheat
 * drivers ban people for, so it is off the table. The practical consequence:
 * this appears over borderless and windowed games — nearly all of them on
 * Windows 11 — but not over true fullscreen-exclusive, where Windows will not
 * put another window on top.
 *
 * Unlike the badges this one takes focus, because it has buttons. The game
 * loses foreground while it is open, same as the Steam and Discord overlays.
 */
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
      // DWM rounds the window itself, so the fill covers the exact shape the
      // panel occupies and there is no corner to pop in later.
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

    // Clicking away is the same as pressing the hotkey again.
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
    // Pressing the hotkey while the panel has focus blurs it first, which hides
    // it — so by the time the key arrives it already looks closed and would
    // reopen immediately. Treat a very recent hide as "it was open".
    if (this.visible || Date.now() - this.hiddenAt < 400) this.hide()
    else this.show()
  }

  show(): void {
    this.create()
    const win = this.window
    if (!win || win.isDestroyed()) return

    // Showing before the renderer has painted flashes the empty window first.
    // Normally this is already true, because the window is created and loaded
    // at startup rather than on the first keypress.
    if (!this.ready) {
      win.once('ready-to-show', () => this.show())
      return
    }

    // Opens on whichever display the cursor is on, which is the one the game is
    // almost certainly running on.
    this.center()
    win.showInactive()
    win.focus()
    // Showing resets the z-order, and the taskbar is topmost in its own right.
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
