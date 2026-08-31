import { BrowserWindow, desktopCapturer, ipcMain, session, type Session } from 'electron'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { AudioSettings } from '@shared/settings'

export const AUDIO_PIPE = '\\\\.\\pipe\\ca_audio'

export interface MicDevice {
  id: string
  label: string
}

interface StatusPayload {
  running: boolean
  error?: string
  devices?: MicDevice[]
}

/**
 * Owns the hidden capture page and the named pipe ffmpeg reads PCM from.
 *
 * The pipe server lives here rather than in the supervisor so a helper restart
 * (device change, default output switched) can be bridged with silence instead
 * of tearing down the encoder — killing ffmpeg would break the ring.
 */
export class AudioEngine extends EventEmitter {
  private window: BrowserWindow | null = null
  private server: Server | null = null
  private client: Socket | null = null
  private ready = false
  private pending: Buffer[] = []
  private devices: MicDevice[] = []

  constructor(private readonly preload = join(__dirname, '../preload/audio.js')) {
    super()
    this.registerIpc()
  }

  getDevices(): MicDevice[] {
    return this.devices
  }

  /** Starts the pipe server. ffmpeg connects to it as a client, so this has to
   *  be listening before the encoder is spawned. */
  async listen(): Promise<void> {
    if (this.server) return
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.client = socket
        socket.on('error', () => undefined)
        socket.on('close', () => {
          if (this.client === socket) this.client = null
        })
        // Anything buffered while ffmpeg was still starting up.
        for (const chunk of this.pending) socket.write(chunk)
        this.pending = []
      })
      server.once('error', reject)
      server.listen(AUDIO_PIPE, () => {
        this.server = server
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    this.stop()
    this.client?.destroy()
    this.client = null
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
    this.window?.destroy()
    this.window = null
    this.ready = false
  }

  async start(settings: AudioSettings): Promise<void> {
    await this.listen()
    await this.ensureWindow()
    this.send({
      type: 'start',
      config: {
        systemEnabled: settings.systemEnabled,
        micEnabled: settings.micEnabled,
        micDeviceId: settings.micDeviceId,
        systemGain: settings.systemGain,
        micGain: settings.micGain
      }
    })
  }

  stop(): void {
    this.send({ type: 'stop' })
  }

  /** Live gain change — used for the mic toggle during a recording, which must
   *  never restart the pipeline. */
  setGains(systemGain: number, micGain: number): void {
    this.send({ type: 'gains', config: { systemGain, micGain } })
  }

  refreshDevices(): void {
    this.send({ type: 'devices' })
  }

  private send(message: unknown): void {
    if (this.ready && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('audio:command', message)
    }
  }

  private async ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return

    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // This page has no visible output, but it must keep pumping audio when
        // every other window is hidden.
        backgroundThrottling: false
      }
    })
    this.window = win
    configureLoopback(win.webContents.session)

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const load = devUrl
      ? win.loadURL(`${devUrl}/audio.html`)
      : win.loadFile(join(__dirname, '../renderer/audio.html'))

    await load
    if (!this.ready) await new Promise<void>((resolve) => this.once('ready', resolve))
  }

  private registerIpc(): void {
    ipcMain.on('audio:ready', () => {
      this.ready = true
      this.emit('ready')
    })

    ipcMain.on('audio:pcm', (_e, buffer: ArrayBuffer) => {
      const chunk = Buffer.from(buffer)
      if (this.client) {
        this.client.write(chunk)
      } else if (this.pending.length < 250) {
        // ~5 seconds of 48k/4ch f32 at 20 ms per block. Past that ffmpeg is not
        // coming and holding more would just grow without bound.
        this.pending.push(chunk)
      }
    })

    ipcMain.on('audio:status', (_e, payload: StatusPayload) => {
      if (payload.devices) this.devices = payload.devices
      this.emit('status', payload)
    })
  }
}

/**
 * Answers the page's `getDisplayMedia` with WASAPI loopback audio.
 *
 * Chromium aborts the request if video was asked for and no video source comes
 * back, so the source has to match what was requested. The page prefers an
 * audio-only request precisely so this branch can skip `desktopCapturer`
 * entirely — a video source we would immediately throw away still spins up a
 * screen capture we are paying for.
 */
function configureLoopback(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!request.videoRequested) {
        callback({ audio: 'loopback' })
        return
      }
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        const [screen] = sources
        callback(screen ? { video: screen, audio: 'loopback' } : { audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )
}
