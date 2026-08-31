import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SupervisorState } from '@shared/state'
import type { SettingsStore } from './store'

function trayIcon(): Electron.NativeImage {
  const packaged = join(process.resourcesPath, 'icon.png')
  const path = existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'icon.png')
  // The source art is 256px; the shell wants 16-32 and scales a large source
  // badly, so resize once here rather than leaving it to Windows.
  return nativeImage.createFromPath(path).resize({ width: 16, height: 16 })
}

const STATE_LABEL: Record<SupervisorState['state'], string> = {
  idle: 'Boşta',
  armed: 'Geçmiş kayıt açık',
  recording: 'Kaydediyor',
  assembling: 'Klip hazırlanıyor'
}

export interface TrayActions {
  showWindow(): void
  toggleReplay(enabled: boolean): void
  toggleRecording(): void
  saveReplay(): void
  quit(): void
}

/**
 * The tray is what keeps the buffer alive after the window closes — without it
 * the app has nowhere to live, and closing the window would mean losing the
 * recording the user just armed.
 *
 * The menu is rebuilt on state change only. Electron menus are immutable, and
 * an app that redraws its tray on a timer shows up in a profile for no reason.
 */
export class TrayController {
  private tray: Tray | null = null
  private state: SupervisorState | null = null

  constructor(
    private readonly store: SettingsStore,
    private readonly actions: TrayActions
  ) {}

  start(): void {
    if (this.tray) return
    this.tray = new Tray(trayIcon())
    this.tray.setToolTip('Capture Assistant')
    this.tray.on('double-click', () => this.actions.showWindow())
    this.render()
  }

  update(state: SupervisorState): void {
    const changed =
      this.state?.state !== state.state || this.state?.micActive !== state.micActive
    this.state = state
    if (changed) this.render()
  }

  /** Settings the menu reflects (replay duration, hotkeys) can change too. */
  refresh(): void {
    this.render()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private render(): void {
    if (!this.tray) return

    const settings = this.store.get()
    const state = this.state
    const armed = state ? state.state !== 'idle' : false
    const recording = state?.state === 'recording'
    const busy = state?.state === 'assembling'

    const minutes = Math.floor(settings.replay.durationSec / 60)
    const seconds = settings.replay.durationSec % 60
    const window = `${minutes}:${String(seconds).padStart(2, '0')}`

    const template: MenuItemConstructorOptions[] = [
      { label: `Capture Assistant — ${STATE_LABEL[state?.state ?? 'idle']}`, enabled: false },
      { type: 'separator' },
      { label: 'Pencereyi aç', click: () => this.actions.showWindow() },
      { type: 'separator' },
      {
        label: 'Geçmiş kayıt',
        type: 'checkbox',
        checked: armed,
        enabled: !busy,
        click: () => this.actions.toggleReplay(!armed)
      },
      {
        label: `Son ${window} kaydet`,
        enabled: armed && !busy,
        click: () => this.actions.saveReplay()
      },
      {
        label: recording ? 'Kaydı durdur' : 'Kaydı başlat',
        enabled: !busy,
        click: () => this.actions.toggleRecording()
      },
      { type: 'separator' },
      { label: 'Çıkış', click: () => this.actions.quit() }
    ]

    this.tray.setContextMenu(Menu.buildFromTemplate(template))
    this.tray.setToolTip(`Capture Assistant — ${STATE_LABEL[state?.state ?? 'idle']}`)
  }
}
