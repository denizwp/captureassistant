import { app, session } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './store'
import { beginQuit, createMainWindow } from './windows'
import { broadcast, registerIpc } from './ipc'
import { AudioEngine } from './audio'
import { SupervisorHost } from './supervisor'
import { TrayController } from './tray'
import { HotkeyManager } from './hotkeys'
import { Overlay } from './overlay'
import { warnIfHotkeysBlocked } from './elevation'
import { Hud } from './hud'
import { runAudioSelfTest } from './audio-selftest'
import { runCaptureSelfTest } from './capture-selftest'

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  const store = new SettingsStore()

  let showWindow = (): void => undefined
  app.on('second-instance', () => showWindow())

  const audio = new AudioEngine()
  const supervisor = new SupervisorHost()

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.captureassistant.app')

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })

    if (process.argv.includes('--audio-test')) {
      await runAudioSelfTest(audio, store)
      app.quit()
      return
    }

    if (process.argv.includes('--capture-test')) {
      await runCaptureSelfTest(supervisor, audio, store)
      supervisor.shutdown()
      await audio.close()
      app.quit()
      return
    }

    supervisor.start(store.get())

    const startHidden = process.argv.includes('--hidden')
    let window = createMainWindow(store, { show: !startHidden })
    showWindow = (): void => {
      if (window.isDestroyed()) window = createMainWindow(store)
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }

    const actions = {
      toggleReplay: (enabled: boolean) => {
        if (enabled) void audio.start(store.get().audio)
        else audio.stop()
        store.update({ replay: { enabled } })
        supervisor.arm(enabled)
      },
      toggleRecording: () => {
        const recording = supervisor.getState().state === 'recording'
        if (!recording) void audio.start(store.get().audio)
        supervisor.record(!recording)
      },
      saveReplay: () => supervisor.saveReplay(),
      toggleMic: () => {
        const next = store.update({
          audio: { micEnabled: !store.get().audio.micEnabled }
        })
        audio.setGains(
          next.audio.systemEnabled ? next.audio.systemGain : 0,
          next.audio.micEnabled ? next.audio.micGain : 0
        )

        supervisor.updateSettings(next)
        broadcast('settings', next)
        broadcast('toast', {
          kind: 'info',
          message: next.audio.micEnabled ? 'Mikrofon açık' : 'Mikrofon kapalı'
        })
      }
    }

    const tray = new TrayController(store, {
      showWindow,
      toggleReplay: (enabled) => actions.toggleReplay(enabled),
      toggleRecording: () => actions.toggleRecording(),
      saveReplay: () => actions.saveReplay(),
      quit: () => {
        beginQuit()
        app.quit()
      }
    })
    tray.start()
    supervisor.on('state', (state) => tray.update(state))

    const hud = new Hud()
    const overlay = new Overlay()
    overlay.create(store.get().app)
    supervisor.on('state', (state) => {
      overlay.update(state, store.get().app)
      if (state.state === 'recording' || state.state === 'armed') {
        void warnIfHotkeysBlocked((message) =>
          broadcast('toast', { kind: 'warning', message })
        )
      }
    })

    const hotkeys = new HotkeyManager()
    hotkeys.on('trigger', (action: string) => {
      switch (action) {
        case 'saveReplay':
          actions.saveReplay()
          break
        case 'toggleRecord':
          actions.toggleRecording()
          break
        case 'toggleReplayBuffer':
          actions.toggleReplay(supervisor.getState().state === 'idle')
          break
        case 'toggleMic':
          actions.toggleMic()
          break
        case 'toggleHud':
          hud.toggle()
          break
        case 'toggleIndicators': {
          const next = store.update({
            app: { alwaysShowIndicators: !store.get().app.alwaysShowIndicators }
          })
          broadcast('settings', next)
          overlay.update(supervisor.getState(), next.app)
          break
        }
      }
    })
    hotkeys.on('conflict', ({ accelerator }: { accelerator: string }) => {
      broadcast('toast', {
        kind: 'warning',
        message: `${accelerator} başka bir uygulama tarafından kullanılıyor.`
      })
    })
    hotkeys.on('warning', (message: string) => {
      broadcast('toast', { kind: 'warning', message })
    })
    hotkeys.start(store.get().hotkeys)

    // The buffer setting is restored rather than cleared: if it was on when the
    // app last closed, arm it again. That is what makes "start with Windows"
    // plus an armed buffer actually mean the buffer is running after a reboot.
    if (store.get().replay.enabled) actions.toggleReplay(true)

    registerIpc(store, audio, supervisor, {
      onSettingsChanged: () => {
        tray.refresh()
        hotkeys.bind(store.get().hotkeys)
        overlay.update(supervisor.getState(), store.get().app)
        hud.setTheme(store.get().app.theme)
      },
      toggleMic: () => actions.toggleMic(),
      openSettings: () => {
        hud.hide()
        showWindow()
      },
      closeHud: () => hud.hide()
    })

    // Only now that the IPC handlers exist: the page requests settings as soon
    // as it loads, and building it earlier left it with a rejected promise and
    // nothing to render. Built up front so the first keypress does not show an
    // unpainted window.
    hud.create(store.get().app.theme)

    app.on('will-quit', () => {
      hotkeys.stop()
      overlay.destroy()
      hud.destroy()
    })

    app.on('activate', showWindow)
  })

  app.on('before-quit', () => {
    beginQuit()
    supervisor.shutdown()
    void audio.close()
  })

  app.on('window-all-closed', () => {
    if (!store.get().app.minimizeToTray) app.quit()
  })
}

export const RENDERER_DIST = join(__dirname, '../renderer')
