import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { AppSettings, IndicatorCorner } from '@shared/settings'
import type { SupervisorState } from '@shared/state'

const MARGIN = 6

const WIDTH = 220

const ROW_HEIGHT = 26
const HEIGHT = 64

const TRANSIENT_MS = 2500

export interface OverlayPayload {
  recording: boolean
  replayArmed: boolean
  micActive: boolean
  elapsedSec: number
  opacity: number
  corner: IndicatorCorner
}

/*
 * setContentProtection(true) is not used here on purpose. Measured on Windows
 * 11 26200 it sets WDA_MONITOR (affinity reads 1) rather than
 * WDA_EXCLUDEFROMCAPTURE (17), so instead of hiding the window from ddagrab it
 * paints a solid black rectangle into every clip and every screenshot. The
 * badge showing up in the footage is the lesser problem.
 */

export class Overlay {
  private window: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private last: OverlayPayload | null = null

  constructor(private readonly preload = join(__dirname, '../preload/overlay.js')) {}

  create(settings: AppSettings): void {
    if (this.window && !this.window.isDestroyed()) return

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,

      minWidth: 1,
      minHeight: 1,
      useContentSize: true,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,

      focusable: false,
      hasShadow: false,
      show: false,
      type: 'toolbar',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    this.window = win

    win.setAlwaysOnTop(true, 'screen-saver')

    win.setIgnoreMouseEvents(true)
    win.setVisibleOnAllWorkspaces(true)

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    void (devUrl
      ? win.loadURL(`${devUrl}/overlay.html`)
      : win.loadFile(join(__dirname, '../renderer/overlay.html')))

    this.position(settings.indicatorCorner)
    screen.on('display-metrics-changed', () => this.position(settings.indicatorCorner))
  }

  private position(corner: IndicatorCorner): void {
    const win = this.window
    if (!win || win.isDestroyed()) return

    const { bounds } = screen.getPrimaryDisplay()

    const x = corner.endsWith('right')
      ? bounds.x + bounds.width - WIDTH - MARGIN
      : bounds.x + MARGIN
    const y = corner.startsWith('bottom')
      ? bounds.y + bounds.height - ROW_HEIGHT - MARGIN
      : bounds.y + MARGIN

    win.setBounds({ x, y, width: WIDTH, height: HEIGHT })
  }

  update(state: SupervisorState, settings: AppSettings): void {
    const payload: OverlayPayload = {
      recording: state.state === 'recording',

      replayArmed: state.state !== 'idle',
      micActive: state.micActive,
      elapsedSec: state.recordingElapsedSec,
      opacity: settings.indicatorOpacity,
      corner: settings.indicatorCorner
    }

    const changed =
      !this.last ||
      this.last.recording !== payload.recording ||
      this.last.replayArmed !== payload.replayArmed ||
      this.last.micActive !== payload.micActive

    this.last = payload
    this.position(settings.indicatorCorner)
    this.apply(payload, changed, settings.alwaysShowIndicators)
  }

  private apply(payload: OverlayPayload, changed: boolean, alwaysShow = false): void {
    const win = this.window
    if (!win || win.isDestroyed()) return

    const anything = payload.recording || payload.replayArmed || payload.micActive
    if (!anything) {
      this.clearTimer()
      win.hide()
      return
    }

    win.webContents.send('overlay:state', payload)

    if (alwaysShow) {
      this.clearTimer()
      this.raise(win)
      return
    }

    if (!changed) return
    this.raise(win)
    this.clearTimer()
    this.hideTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.hide()
      this.hideTimer = null
    }, TRANSIENT_MS)
  }

  private raise(win: BrowserWindow): void {
    if (!win.isVisible()) win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  private clearTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  destroy(): void {
    this.clearTimer()
    this.window?.destroy()
    this.window = null
  }
}
