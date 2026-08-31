import { app, globalShortcut } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { UiohookKey, uIOhook, type UiohookKeyboardEvent } from 'uiohook-napi'
import type { HotkeySettings } from '@shared/settings'

export type HotkeyAction = keyof HotkeySettings

/** Electron accelerator key names -> uiohook keycodes. Only the keys an
 *  accelerator can actually name; anything else is rejected at bind time. */
const KEYCODES: Record<string, number> = {
  ...Object.fromEntries(
    Object.entries(UiohookKey).filter(([, value]) => typeof value === 'number')
  ),
  Up: UiohookKey.ArrowUp,
  Down: UiohookKey.ArrowDown,
  Left: UiohookKey.ArrowLeft,
  Right: UiohookKey.ArrowRight,
  Esc: UiohookKey.Escape,
  Return: UiohookKey.Enter,
  Plus: UiohookKey.Equal,
  ';': UiohookKey.Semicolon,
  '=': UiohookKey.Equal,
  ',': UiohookKey.Comma,
  '-': UiohookKey.Minus,
  '.': UiohookKey.Period,
  '/': UiohookKey.Slash,
  '`': UiohookKey.Backquote,
  '[': UiohookKey.BracketLeft,
  '\\': UiohookKey.Backslash,
  ']': UiohookKey.BracketRight,
  "'": UiohookKey.Quote
}

interface Binding {
  action: HotkeyAction
  accelerator: string
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

function parse(action: HotkeyAction, accelerator: string): Binding | null {
  const parts = accelerator.split('+').map((part) => part.trim())
  const key = parts.at(-1)
  if (!key) return null

  const keycode = KEYCODES[key] ?? KEYCODES[key.toUpperCase()]
  if (typeof keycode !== 'number') return null

  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase())
  return {
    action,
    accelerator,
    keycode,
    ctrl: modifiers.includes('ctrl') || modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift'),
    meta: modifiers.includes('super') || modifiers.includes('meta') || modifiers.includes('cmd')
  }
}

/**
 * Set CA_DEBUG_HOTKEYS=1 to record every key the hook sees.
 *
 * Worth having a switch for: when a binding does not fire there is no way to
 * tell from outside whether the hook is dead, the modifiers did not match, or
 * the action ran and did nothing. Electron on Windows does not attach to the
 * parent console, so this goes to a file.
 */
const DEBUG = process.env['CA_DEBUG_HOTKEYS'] === '1'
let debugPath = ''

function debug(message: string): void {
  if (!DEBUG) return
  if (!debugPath) debugPath = join(app.getPath('temp'), 'ca-hotkeys.log')
  try {
    appendFileSync(debugPath, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never take the app down.
  }
}

/** Long enough to swallow the second delivery of one physical press, short
 *  enough that a deliberate double-tap still registers twice. */
const DEDUP_MS = 250

/** Windows silently stops calling a low-level hook that overruns
 *  `LowLevelHooksTimeout`, and never tells you. Periodic reinstallation is the
 *  only defence. */
const WATCHDOG_MS = 30_000

/**
 * Global hotkeys, on two independent paths.
 *
 * The low-level hook is primary because `RegisterHotKey` — which is what
 * Electron's `globalShortcut` uses — is *exclusive*: it steals the combination
 * from every other app, and some games (League of Legends is the usual example)
 * block it outright. A `WH_KEYBOARD_LL` hook only observes, never consumes, so
 * game input is untouched. `globalShortcut` stays registered as a second path
 * for the cases where the hook cannot be installed, with a dedup window so one
 * press does not fire twice.
 */
export class HotkeyManager extends EventEmitter {
  private bindings: Binding[] = []
  private hookRunning = false
  private watchdog: NodeJS.Timeout | null = null
  private lastFired = new Map<HotkeyAction, number>()
  private lastEventAt = 0

  start(hotkeys: HotkeySettings): void {
    this.bind(hotkeys)
    this.startHook()
    this.watchdog = setInterval(() => this.checkHook(), WATCHDOG_MS)
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    globalShortcut.unregisterAll()
    this.stopHook()
  }

  /** Rebinding is cheap; the hook itself keeps running. */
  bind(hotkeys: HotkeySettings): void {
    this.bindings = []
    globalShortcut.unregisterAll()

    for (const [action, accelerator] of Object.entries(hotkeys) as [HotkeyAction, string][]) {
      const binding = parse(action, accelerator)
      if (!binding) {
        this.emit('warning', `Kısayol tanınmadı: ${accelerator}`)
        continue
      }
      this.bindings.push(binding)
      debug(
        `bound ${action} = ${accelerator} -> keycode ${binding.keycode} ` +
          `ctrl=${binding.ctrl} alt=${binding.alt} shift=${binding.shift} meta=${binding.meta}`
      )

      try {
        // Registration failing means another app already owns the combination.
        // Not fatal — the hook still sees it — but worth surfacing.
        if (!globalShortcut.register(accelerator, () => this.fire(action, 'globalShortcut'))) {
          this.emit('conflict', { action, accelerator })
        }
      } catch {
        this.emit('conflict', { action, accelerator })
      }
    }
  }

  private startHook(): void {
    if (this.hookRunning) return
    try {
      uIOhook.on('keydown', this.onKeyDown)
      uIOhook.start()
      this.hookRunning = true
      debug('hook started')
    } catch (error) {
      // Anti-cheat or a locked-down session can refuse the hook. globalShortcut
      // carries the feature alone in that case.
      this.emit('warning', `Klavye dinleyicisi kurulamadı: ${String(error)}`)
    }
  }

  private stopHook(): void {
    if (!this.hookRunning) return
    try {
      uIOhook.off('keydown', this.onKeyDown)
      uIOhook.stop()
    } catch {
      // Already gone.
    }
    this.hookRunning = false
  }

  /**
   * Reinstalls the hook if it has gone quiet.
   *
   * A machine can genuinely sit untouched for thirty seconds, so silence alone
   * is not proof the hook died — but reinstalling costs nothing and is the only
   * way back from a hook Windows has dropped.
   */
  private checkHook(): void {
    if (!this.hookRunning) {
      this.startHook()
      return
    }
    if (Date.now() - this.lastEventAt > WATCHDOG_MS * 2) {
      this.stopHook()
      this.startHook()
    }
  }

  private readonly onKeyDown = (event: UiohookKeyboardEvent): void => {
    this.lastEventAt = Date.now()
    debug(
      `key ${event.keycode} ctrl=${event.ctrlKey} alt=${event.altKey} ` +
        `shift=${event.shiftKey} meta=${event.metaKey}`
    )

    for (const binding of this.bindings) {
      if (
        event.keycode === binding.keycode &&
        event.ctrlKey === binding.ctrl &&
        event.altKey === binding.alt &&
        event.shiftKey === binding.shift &&
        event.metaKey === binding.meta
      ) {
        this.fire(binding.action, 'hook')
        return
      }
    }
  }

  private fire(action: HotkeyAction, source: 'hook' | 'globalShortcut'): void {
    const now = Date.now()
    const previous = this.lastFired.get(action) ?? 0
    // Both paths see the same press; whichever arrives first wins.
    if (now - previous < DEDUP_MS) {
      debug(`deduped ${action} from ${source}`)
      return
    }
    this.lastFired.set(action, now)
    debug(`fired ${action} from ${source}`)
    this.emit('trigger', action, source)
  }
}
