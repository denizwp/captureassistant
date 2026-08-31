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

export class AudioEngine extends EventEmitter {
  private window: BrowserWindow | null = null
  private server: Server | null = null
  private client: Socket | null = null
  private ready = false
  private pending: Buffer[] = []
  private devices: MicDevice[] = []
  private appAudio: Buffer = Buffer.alloc(0)
  private appAudioActive = false

  constructor(private readonly preload = join(__dirname, '../preload/audio.js')) {
    super()
    this.registerIpc()
  }

  getDevices(): MicDevice[] {
    return this.devices
  }

  /*
   * The native helper and the capture page are clocked independently, so instead
   * of trying to keep them in lockstep the helper's samples are queued and the
   * page's blocks decide how many get consumed. Short means pad with silence,
   * long means throw the oldest away — a queue left to grow would turn into
   * ever-increasing lag against the video.
   */
  private static readonly MAX_QUEUE_BYTES = 48_000 * 2 * 4 * 0.2

  useAppAudio(active: boolean): void {
    this.appAudioActive = active
    this.appAudio = Buffer.alloc(0)
  }

  pushAppAudio(chunk: Buffer): void {
    if (!this.appAudioActive) return
    this.appAudio = Buffer.concat([this.appAudio, chunk])
    const max = AudioEngine.MAX_QUEUE_BYTES
    if (this.appAudio.length > max) {
      this.appAudio = this.appAudio.subarray(this.appAudio.length - max)
    }
  }

  private applyAppAudio(block: Buffer): Buffer {
    if (!this.appAudioActive) return block

    const frames = block.length / 16
    const wanted = frames * 8
    const take = Math.min(wanted, this.appAudio.length - (this.appAudio.length % 8))
    const source = this.appAudio.subarray(0, take)
    this.appAudio = this.appAudio.subarray(take)

    for (let i = 0; i < frames; i++) {
      const at = i * 8
      if (at + 8 <= source.length) {
        block.writeFloatLE(source.readFloatLE(at), i * 16)
        block.writeFloatLE(source.readFloatLE(at + 4), i * 16 + 4)
      } else {
        block.writeFloatLE(0, i * 16)
        block.writeFloatLE(0, i * 16 + 4)
      }
    }
    return block
  }

  async listen(): Promise<void> {
    if (this.server) return
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.client = socket
        socket.on('error', () => undefined)
        socket.on('close', () => {
          if (this.client === socket) this.client = null
        })

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

  setGains(systemGain: number, micGain: number): void {
    this.send({ type: 'gains', config: { systemGain, micGain } })
  }

  refreshDevices(): void {
    this.send({ type: 'devices' })
  }

  setMetering(enabled: boolean): void {
    this.send({ type: 'meter', enabled })
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
      const chunk = this.applyAppAudio(Buffer.from(buffer))
      if (this.client) {
        this.client.write(chunk)
      } else if (this.pending.length < 250) {
        this.pending.push(chunk)
      }
    })

    ipcMain.on('audio:levels', (_e, payload: { system: number; mic: number }) => {
      this.emit('levels', payload)
    })

    ipcMain.on('audio:status', (_e, payload: StatusPayload) => {
      if (payload.devices) this.devices = payload.devices
      this.emit('status', payload)
    })
  }
}

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
