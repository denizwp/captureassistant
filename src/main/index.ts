import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './store'
import { createMainWindow } from './windows'
import { registerIpc } from './ipc'
import { AudioEngine } from './audio'
import { SupervisorHost } from './supervisor'
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

  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
    }
  })

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

    supervisor.start(store.get())
    registerIpc(store, audio, supervisor)
    createMainWindow(store)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(store)
    })
  })

  app.on('before-quit', () => {
    supervisor.shutdown()
    void audio.close()
  })

  // The tray keeps the buffer alive after the window closes, so on Windows we
  // deliberately do NOT quit here once the tray lands. Until then, quit.
  app.on('window-all-closed', () => {
    app.quit()
  })
}

export const RENDERER_DIST = join(__dirname, '../renderer')
