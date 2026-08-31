import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { AppSettings, IndicatorCorner } from '@shared/settings'
import type { SupervisorState } from '@shared/state'

/** Small enough that the badges read as sitting in the corner rather than
 *  floating near it. */
const MARGIN = 6
/** Wide enough for all three badges plus the timer; the row is anchored
 *  inside, so the spare width is empty and click-through. */
const WIDTH = 220

/**
 * Chromium clamps this window to a minimum height (measured: 64px, whatever we
 * ask for), so the window is not a reliable way to place the badges. The row is
 * pinned to the *top* of the window instead and the window is positioned so
 * that top lands where the badges belong. Whatever height Chromium insists on
 * then hangs below, transparent and click-through, behind the taskbar.
 */
const ROW_HEIGHT = 26
const HEIGHT = 64

/** How long the badges stay up after a state change while a game is foreground. */
const TRANSIENT_MS = 2500

export interface OverlayPayload {
  recording: boolean
  replayArmed: boolean
  micActive: boolean
  elapsedSec: number
  opacity: number
  corner: IndicatorCorner
}

/**
 * The bottom-corner status badges.
 *
 * Two problems, and only one of them has a good answer.
 *
 * Getting recorded: `ddagrab` duplicates the whole desktop, so a visible badge
 * lands in the footage. `setContentProtection(true)` looks like the fix, but
 * measured on Windows 11 build 26200 it sets `WDA_MONITOR` (affinity reads 1),
 * not `WDA_EXCLUDEFROMCAPTURE` (17) — which paints a solid black rectangle into
 * every capture and every screenshot instead of hiding the window. A black box
 * in the user's clips is worse than a small badge, so it is deliberately not
 * used. Excluding the window properly needs `SetWindowDisplayAffinity` called
 * from inside this process, which needs a native module we do not have yet.
 *
 * Costing frames: a borderless game gets direct scanout from DWM, and one pixel
 * of another window on top forces composition and drops VRR — which is why the
 * Discord overlay is famous for breaking G-Sync. Transparent or not, the window
 * is still composited. So unless the user opts into always-on badges, they show
 * for a moment on a state change and then genuinely `hide()`, which removes the
 * HWND from the compositor's list and lets direct scanout resume. `opacity: 0`
 * and a 1x1 window both fail at this: DWM keeps compositing them.
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
      // Chromium enforces a minimum window size unless told otherwise; without
      // these the window comes back 64px tall, hangs below the work area and
      // the badges end up behind the taskbar.
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
      // Must never steal focus from the game.
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
    // No `{ forward: true }`: forwarding keeps Chromium hit-testing and
    // dispatching synthetic mouse moves, and nothing here has a hover state.
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
    // The full display, not the work area: the badges belong in the corner of
    // the screen. The window is always-on-top, so it draws over the taskbar
    // rather than being pushed above it.
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
      // Recording and the buffer share one encoder, so the buffer is still
      // armed while a manual recording runs.
      replayArmed: state.state !== 'idle',
      micActive: state.micActive,
      elapsedSec: state.recordingElapsedSec,
      opacity: settings.indicatorOpacity,
      corner: settings.indicatorCorner
    }

    // A changed badge set is worth surfacing; a ticking timer is not.
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

    // Show on a change, then get out of the way — both so the badge stays out
    // of the footage and so DWM can go back to direct scanout.
    if (!changed) return
    this.raise(win)
    this.clearTimer()
    this.hideTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.hide()
      this.hideTimer = null
    }, TRANSIENT_MS)
  }

  /** Shows without focus and re-asserts topmost.
   *
   *  Showing a window puts it back in the normal z-order, and the badges are
   *  positioned over the taskbar, which is topmost itself — so the level has to
   *  be set again every time or the badges end up behind it. */
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
