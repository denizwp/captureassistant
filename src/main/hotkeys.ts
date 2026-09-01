import { app, globalShortcut } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { UiohookKey, uIOhook, type UiohookKeyboardEvent } from 'uiohook-napi'
import type { HotkeySettings } from '@shared/settings'

export type HotkeyAction = keyof HotkeySettings

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
  "'": UiohookKey.Quote,
  numadd: UiohookKey.NumpadAdd,
  numsub: UiohookKey.NumpadSubtract,
  nummult: UiohookKey.NumpadMultiply,
  numdiv: UiohookKey.NumpadDivide,
  numdec: UiohookKey.NumpadDecimal,
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_v, i) => [`num${i}`, UiohookKey[`Numpad${i}` as never]])
  )
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
  // A trailing "+" is a literal plus, not an empty final part.
  const parts = accelerator
    .replace(/\+\+$/, '+Plus')
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
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

const DEBUG = process.env['CA_DEBUG_HOTKEYS'] === '1'
let debugPath = ''

function write(message: string): void {
  if (!debugPath) debugPath = join(app.getPath('temp'), 'ca-hotkeys.log')
  try {
    appendFileSync(debugPath, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

function debug(message: string): void {
  if (DEBUG) write(message)
}

const DEDUP_MS = 200

const WATCHDOG_MS = 30_000

/*
 * Windows stops calling a low-level hook that overruns LowLevelHooksTimeout and
 * never says so, which leaves hookRunning true while no key ever arrives again.
 * Silence is the only symptom we can see, so treat a long enough one as a dead
 * hook — reinstalling costs nothing if it turns out the user was just idle.
 */
const HOOK_SILENCE_MS = 5 * 60_000

export class HotkeyManager extends EventEmitter {
  private bindings: Binding[] = []
  private hookRunning = false
  private watchdog: NodeJS.Timeout | null = null
  private lastFired = new Map<HotkeyAction, number>()
  private lastEventAt = 0

  start(hotkeys: HotkeySettings): void {
    this.startHook()
    this.bind(hotkeys)
    this.watchdog = setInterval(() => this.checkHook(), WATCHDOG_MS)
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    globalShortcut.unregisterAll()
    this.stopHook()
  }

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

      if (this.hookRunning) continue

      try {
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
      this.lastEventAt = Date.now()
      write('hook installed; globalShortcut not needed')

      globalShortcut.unregisterAll()
    } catch (error) {
      this.emit('warning', `Klavye dinleyicisi kurulamadı: ${String(error)}`)
    }
  }

  private stopHook(): void {
    if (!this.hookRunning) return
    try {
      uIOhook.off('keydown', this.onKeyDown)
      uIOhook.stop()
    } catch {}
    this.hookRunning = false
  }

  private checkHook(): void {
    if (!this.hookRunning) {
      this.startHook()
      return
    }
    if (Date.now() - this.lastEventAt < HOOK_SILENCE_MS) return
    write('no key events for a while — reinstalling the hook')
    this.stopHook()
    this.startHook()
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

    if (now - previous < DEDUP_MS) {
      debug(`deduped ${action} from ${source}`)
      return
    }
    this.lastFired.set(action, now)

    write(`fired ${action} from ${source}`)
    this.emit('trigger', action, source)
  }
}
