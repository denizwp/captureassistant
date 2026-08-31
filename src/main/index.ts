import { app, session } from 'electron'
import { join } from 'node:path'
import { discardLegacyUserData, SettingsStore } from './store'
import { beginQuit, createMainWindow } from './windows'
import { broadcast, registerIpc } from './ipc'
import { AudioEngine } from './audio'
import { SupervisorHost } from './supervisor'
import { TrayController } from './tray'
import { HotkeyManager } from './hotkeys'
import { Overlay } from './overlay'
import { warnIfHotkeysBlocked } from './elevation'
import { warnIfHdr } from './hdr'
import { pruneThumbnails } from './thumbnails'
import { AppAudioCapture } from './app-audio'
import { checkForUpdate, discardOldBuild, runUpdateSelfTest } from './updater'
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

    const appAudio = new AppAudioCapture()
    let appAudioKey = ''
    let rescan: ReturnType<typeof setInterval> | null = null

    const applyAppAudio = async (): Promise<void> => {
      const config = store.get().audio
      audio.setSystemGain(config.systemEnabled ? config.systemGain : 0)
      if (!config.systemEnabled) {
        appAudio.stop()
        audio.useAppAudio(false)
        return
      }
      const muted = config.mutedApps
      const active = await appAudio.sync(
        muted,
        (pid, chunk) => audio.pushAppAudio(pid, chunk),
        (message) => {
          supervisor.note(`app audio: ${message}`)
          broadcast('toast', { kind: 'warning', message })
        },
        (pid) => audio.dropAppAudio(pid)
      )
      supervisor.note(`system audio helpers: ${active ? 'running' : 'none'}`)
      audio.useAppAudio(active)
    }

    const startAudio = async (): Promise<void> => {
      const config = store.get().audio
      // The capture page only handles the microphone now; system audio comes
      // from the helper, which sees it without Chromium's buffering in between.
      await audio.start({ ...config, systemEnabled: false })
      appAudioKey = config.mutedApps.join(',')
      await applyAppAudio()
      // Apps come and go mid-session, so keep checking which ones still need a
      // helper rather than freezing the list at the moment recording started.
      if (rescan === null && config.mutedApps.length > 0) {
        rescan = setInterval(() => void applyAppAudio().catch(() => undefined), 5000)
      }
    }

    const stopAudio = (): void => {
      if (rescan !== null) {
        clearInterval(rescan)
        rescan = null
      }
      appAudio.stop()
      audio.useAppAudio(false)
      audio.stop()
    }

    /*
     * Settings can change while the buffer is already running, and the capture
     * page only reads them once at start. Push the ones that can be applied to a
     * live graph so a toggle takes effect now rather than at the next arm.
     */
    const syncAudio = async (): Promise<void> => {
      const config = store.get().audio
      audio.setMic(config.micEnabled, config.micDeviceId, config.micGain)
      audio.setSystemGain(config.systemEnabled ? config.systemGain : 0)
      audio.setGains(0, config.micEnabled ? config.micGain : 0)

      const key = config.mutedApps.join(',')
      if (key === appAudioKey) return
      appAudioKey = key

      if (supervisor.getState().state === 'idle') return
      await applyAppAudio()

      if (config.mutedApps.length > 0 && rescan === null) {
        rescan = setInterval(() => void applyAppAudio().catch(() => undefined), 5000)
      } else if (config.mutedApps.length === 0 && rescan !== null) {
        clearInterval(rescan)
        rescan = null
      }
    }

    if (process.argv.includes('--update-test')) {
      await runUpdateSelfTest()
      app.quit()
      return
    }

    if (process.argv.includes('--audio-test')) {
      await runAudioSelfTest(audio, store)
      app.quit()
      return
    }

    if (process.argv.includes('--capture-test')) {
      await runCaptureSelfTest(supervisor, audio, store, startAudio)
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
      toggleReplay: async (enabled: boolean) => {
        if (enabled) await startAudio()
        else stopAudio()
        // The supervisor sizes the ring from its own copy of the settings, so it
        // has to hear about this before arming or it prunes to the idle window.
        const next = store.update({ replay: { enabled } })
        supervisor.updateSettings(next)
        broadcast('settings', next)
        supervisor.arm(enabled)
      },
      toggleRecording: async () => {
        const recording = supervisor.getState().state === 'recording'
        if (!recording) await startAudio()
        supervisor.record(!recording)
      },
      saveReplay: () => supervisor.saveReplay(),
      toggleMic: () => {
        const next = store.update({
          audio: { micEnabled: !store.get().audio.micEnabled }
        })
        audio.setMic(next.audio.micEnabled, next.audio.micDeviceId, next.audio.micGain)
        audio.setGains(0, next.audio.micEnabled ? next.audio.micGain : 0)

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
      toggleReplay: (enabled) => void actions.toggleReplay(enabled),
      toggleRecording: () => void actions.toggleRecording(),
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
        warnIfHdr((message) => broadcast('toast', { kind: 'warning', message }))
      }
    })

    const hotkeys = new HotkeyManager()
    hotkeys.on('trigger', (action: string) => {
      switch (action) {
        case 'saveReplay':
          actions.saveReplay()
          break
        case 'toggleRecord':
          void actions.toggleRecording()
          break
        case 'toggleReplayBuffer':
          void actions.toggleReplay(!store.get().replay.enabled)
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

    if (store.get().replay.enabled) void actions.toggleReplay(true)

    registerIpc(store, audio, supervisor, {
      onSettingsChanged: () => {
        tray.refresh()
        hotkeys.bind(store.get().hotkeys)
        overlay.update(supervisor.getState(), store.get().app)
        hud.setTheme(store.get().app.theme)
        void syncAudio()
      },
      toggleReplay: (enabled: boolean) => actions.toggleReplay(enabled),
      toggleRecording: () => actions.toggleRecording(),
      saveReplay: () => actions.saveReplay(),
      toggleMic: () => actions.toggleMic(),
      openSettings: () => {
        hud.hide()
        showWindow()
      },
      closeHud: () => hud.hide()
    })

    hud.create(store.get().app.theme)

    void pruneThumbnails()
    void discardLegacyUserData()
    void discardOldBuild()
    setTimeout(() => void checkForUpdate().catch(() => undefined), 4000)

    app.on('will-quit', () => {
      hotkeys.stop()
      overlay.destroy()
      hud.destroy()
      // Helper processes are plain children on Windows and outlive us otherwise,
      // each one holding a loopback session open.
      stopAudio()
      supervisor.shutdown()
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
