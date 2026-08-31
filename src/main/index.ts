import { app, session } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './store'
import { beginQuit, createMainWindow } from './windows'
import { registerIpc } from './ipc'
import { AudioEngine } from './audio'
import { SupervisorHost } from './supervisor'
import { TrayController } from './tray'
import { runAudioSelfTest } from './audio-selftest'
import { runCaptureSelfTest } from './capture-selftest'

/**
 * Performance switches, applied before `app.whenReady()` because Chromium reads
 * them during startup.
 *
 * The UI is a static settings panel plus a 220x96 badge window, so software
 * rasterisation is plenty — and dropping the GPU process means Chromium stops
 * holding a D3D11 device that competes with the game for GPU scheduling. That
 * contention is the specific way Electron apps hurt frame rates.
 */
app.disableHardwareAcceleration()
// Occlusion calculation walks desktop geometry on a timer and interacts badly
// with fullscreen games.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  const store = new SettingsStore()

  // Assigned once the window exists. A second launch while the app sits in the
  // tray should surface the window, not start a second recorder.
  let showWindow = (): void => undefined
  app.on('second-instance', () => showWindow())

  const audio = new AudioEngine()
  const supervisor = new SupervisorHost()

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.captureassistant.app')

    // The capture page needs the microphone; nothing else in the app asks for
    // a permission, so anything other than `media` is denied outright.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })

    // `--audio-test` records ten seconds through the real audio path to a wav
    // and exits. It is how the pipe, the worklet and the loopback handler get
    // verified without driving the UI.
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

    // The engine starts idle, so the stored flag has to agree. Leaving it true
    // from a previous session made the UI offer a buffer that did not exist.
    store.update({ replay: { enabled: false } })
    supervisor.start(store.get())

    const startHidden = process.argv.includes('--hidden')
    let window = createMainWindow(store, { show: !startHidden })
    showWindow = (): void => {
      if (window.isDestroyed()) window = createMainWindow(store)
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }

    const tray = new TrayController(store, {
      showWindow,
      toggleReplay: (enabled) => {
        void (enabled ? audio.start(store.get().audio) : Promise.resolve(audio.stop()))
        store.update({ replay: { enabled } })
        supervisor.arm(enabled)
      },
      toggleRecording: () => {
        const recording = supervisor.getState().state === 'recording'
        if (!recording) void audio.start(store.get().audio)
        supervisor.record(!recording)
      },
      saveReplay: () => supervisor.saveReplay(),
      quit: () => {
        beginQuit()
        app.quit()
      }
    })
    tray.start()
    supervisor.on('state', (state) => tray.update(state))

    registerIpc(store, audio, supervisor, () => tray.refresh())

    app.on('activate', showWindow)
  })

  app.on('before-quit', () => {
    beginQuit()
    supervisor.shutdown()
    void audio.close()
  })

  // The tray keeps the app alive with no windows open — that is how the buffer
  // survives closing the window.
  app.on('window-all-closed', () => {
    if (!store.get().app.minimizeToTray) app.quit()
  })
}

export const RENDERER_DIST = join(__dirname, '../renderer')
