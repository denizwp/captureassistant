import { app, session } from 'electron'

import { discardLegacyUserData, SettingsStore } from './store'
import { beginQuit, createMainWindow } from './windows'
import { broadcast, registerIpc } from './ipc'
import { ChatCapture } from './chat'
import { chatArchiveDir, registerChatIpc, writeChatBeside } from './chat/ipc'
import { AudioEngine } from './audio'
import { ringDirFor, SupervisorHost } from './supervisor'
import { TrayController } from './tray'
import { HotkeyManager } from './hotkeys'
import { Overlay } from './overlay'
import { warnIfHotkeysBlocked } from './elevation'
import { warnIfHdr } from './hdr'
import { pruneThumbnails } from './thumbnails'
import { AppAudioCapture } from './app-audio'
import { checkForUpdate, discardOldBuild, runUpdateSelfTest } from './updater'
import { Hud } from './hud'
import { logEntry, writeHeader } from './log'
import { runAudioSelfTest } from './audio-selftest'
import { runCaptureSelfTest } from './capture-selftest'
import { runChatSelfTest } from './chat-selftest'

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

    const applyAppAudio = async (): Promise<void> => {
      const config = store.get().audio
      audio.setSystemGain(config.systemEnabled ? config.systemGain : 0)
      if (!config.systemEnabled) {
        appAudio.stop()
        audio.useAppAudio(false)
        return
      }
      const active = await appAudio.sync(
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
      await applyAppAudio()
    }

    const stopAudio = (): void => {
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
    }

    /*
     * Every one of these takes a while and can be fired from the window, the
     * HUD, the tray and a hotkey at once. The supervisor serialises its
     * messages, so a spammed button does not race — it queues, and the user
     * gets a run of clips they never asked for. Drop the extra presses instead,
     * and tell the renderer so the buttons can go quiet.
     */
    let busy: string | null = null
    const setBusy = (name: string | null): void => {
      busy = name
      broadcast('busy', name)
    }

    const exclusive = async (name: string, run: () => Promise<void> | void): Promise<void> => {
      if (busy) return
      setBusy(name)
      try {
        await run()
      } finally {
        setBusy(null)
      }
    }

    /* Assembly runs inside the supervisor, so stay busy until it comes back. */
    const untilAssembled = (): Promise<void> =>
      new Promise((resolve) => {
        let entered = false
        const done = (): void => {
          supervisor.off('state', watch)
          clearTimeout(giveUp)
          resolve()
        }
        const watch = (next: { state: string }): void => {
          if (next.state === 'assembling') entered = true
          else if (entered) done()
        }
        const giveUp = setTimeout(done, 120_000)
        supervisor.on('state', watch)
        setTimeout(() => {
          if (!entered) done()
        }, 3000)
      })

    const actions = {
      toggleReplay: (enabled: boolean) =>
        exclusive('replay', async () => {
          if (enabled) await startAudio()
          else stopAudio()
          // The supervisor sizes the ring from its own copy of the settings, so
          // it has to hear about this before arming or it prunes to the idle
          // window.
          const next = store.update({ replay: { enabled } })
          supervisor.updateSettings(next)
          broadcast('settings', next)
          supervisor.arm(enabled)
        }),
      toggleRecording: () =>
        exclusive('record', async () => {
          const recording = supervisor.getState().state === 'recording'
          if (!recording) await startAudio()
          supervisor.record(!recording)
          if (!recording) return
          await untilAssembled()
          // Nothing left to feed once the clip is written, and a loopback helper
          // left running holds an audio session open for good. Driven from the
          // intent rather than from an idle state: the supervisor also reports
          // idle in the moment between the sound starting and the buffer arming.
          if (!store.get().replay.enabled) stopAudio()
        }),
      saveReplay: () =>
        exclusive('save', async () => {
          supervisor.saveReplay()
          await untilAssembled()
        }),
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

    if (process.argv.includes('--update-test')) {
      await runUpdateSelfTest()
      app.quit()
      return
    }

    if (process.argv.includes('--chat-test')) {
      await runChatSelfTest()
      app.quit()
      return
    }

    if (process.argv.includes('--audio-test')) {
      await runAudioSelfTest(audio, store)
      app.quit()
      return
    }

    if (process.argv.includes('--capture-test')) {
      await runCaptureSelfTest(supervisor, store, startAudio, actions)
      supervisor.shutdown()
      await audio.close()
      app.quit()
      return
    }

    supervisor.on('log', (entry: { level: string; line: string }) => logEntry(entry.level, entry.line))
    supervisor.on('toast', (t: { kind: string; message: string }) => logEntry(t.kind, `toast: ${t.message}`))
    supervisor.on('clip', (clip: { path: string; durationSec: number }) =>
      logEntry('info', `clip written: ${clip.path} (${clip.durationSec.toFixed(1)}s)`)
    )
    void writeHeader(store.get(), ringDirFor(store.get()), store.get().output.dir ?? '')

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

    const chat = new ChatCapture(chatArchiveDir(store))
    chat.on('status', (status: unknown) => broadcast('chat-status', status))
    chat.on('lines', (lines: unknown) => broadcast('chat-lines', lines))
    registerChatIpc(store, chat)
    const syncChat = (): void => {
      chat.setRoot(chatArchiveDir(store))
      if (store.get().chat.enabled) chat.start()
      else void chat.stop()
    }
    syncChat()

    /*
     * A clip on its own does not say what was going on around it. When chat is
     * being followed, the lines covering the same stretch of time are written
     * beside it under the same name, so the two travel together.
     */
    supervisor.on('clip', (clip: { path: string; durationSec: number }) => {
      if (!store.get().chat.enabled) return
      void writeChatBeside(chat.getLines(), clip.path, clip.durationSec)
        .then((written) => {
          if (written) logEntry('info', `chat written beside clip: ${written}`)
        })
        .catch((error: unknown) => logEntry('warning', `chat sidecar failed: ${String(error)}`))
    })

    registerIpc(store, audio, supervisor, {
      onSettingsChanged: () => {
        tray.refresh()
        hotkeys.bind(store.get().hotkeys)
        overlay.update(supervisor.getState(), store.get().app)
        hud.setTheme(store.get().app.theme)
        void syncAudio()
        syncChat()
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
    setTimeout(
      () =>
        void checkForUpdate({
          onDownloadStart: () => {
            setBusy('update')
            broadcast('toast', { kind: 'info', message: 'Güncelleme indiriliyor…' })
          },
          onDownloadEnd: () => setBusy(null)
        }).catch(() => undefined),
      4000
    )

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

