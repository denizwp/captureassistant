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

  constructor(private readonly preload = join(__dirname, '../preload/audio.js')) {
    super()
    this.registerIpc()
  }

  getDevices(): MicDevice[] {
    return this.devices
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
      const chunk = Buffer.from(buffer)
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
