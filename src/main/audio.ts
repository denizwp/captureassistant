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
  latencySec?: number
}

export class AudioEngine extends EventEmitter {
  private window: BrowserWindow | null = null
  private server: Server | null = null
  private client: Socket | null = null
  private ready = false
  private pending: Buffer[] = []
  private devices: MicDevice[] = []
  private appAudio = new Map<number, Buffer>()
  private appAudioActive = false
  private skipBytes = 0

  constructor(private readonly preload = join(__dirname, '../preload/audio.js')) {
    super()
    this.registerIpc()
  }

  getDevices(): MicDevice[] {
    return this.devices
  }

  /*
   * Helpers and the capture page are clocked independently, so rather than try
   * to keep them in lockstep each helper's samples are queued and the page's
   * blocks decide how many get consumed. Short means pad with silence, long
   * means drop the oldest — a queue left to grow becomes ever-increasing lag
   * against the video.
   */
  private static readonly MAX_PENDING_BLOCKS = 5

  private static readonly MAX_QUEUE_BYTES = 48_000 * 2 * 4 * 0.2

  /*
   * Samples reach ffmpeg later than the frames they belong to, and it stamps
   * them on arrival, so the sound ends up behind the picture. Dropping that much
   * from the head of the stream pulls it back into line. Doing it here rather
   * than with an atrim in the filter graph matters: a filter that keeps
   * discarding audio starves the ddagrab source and the capture drops to a few
   * frames a second.
   */
  setSkip(seconds: number): void {
    const frames = Math.max(0, Math.round(seconds * 48_000))
    this.skipBytes = frames * 4 * 4
  }

  useAppAudio(active: boolean): void {
    this.appAudioActive = active
    this.appAudio.clear()
  }

  pushAppAudio(source: number, chunk: Buffer): void {
    if (!this.appAudioActive) return
    const queued = Buffer.concat([this.appAudio.get(source) ?? Buffer.alloc(0), chunk])
    const max = AudioEngine.MAX_QUEUE_BYTES
    this.appAudio.set(source, queued.length > max ? queued.subarray(queued.length - max) : queued)
  }

  dropAppAudio(source: number): void {
    this.appAudio.delete(source)
  }

  private applyAppAudio(block: Buffer): Buffer {
    if (!this.appAudioActive) return block

    const frames = block.length / 16
    const wanted = frames * 8

    const takes: Buffer[] = []
    for (const [source, queued] of this.appAudio) {
      const usable = Math.min(wanted, queued.length - (queued.length % 8))
      takes.push(queued.subarray(0, usable))
      this.appAudio.set(source, queued.subarray(usable))
    }

    for (let i = 0; i < frames; i++) {
      let left = 0
      let right = 0
      for (const take of takes) {
        const at = i * 8
        if (at + 8 > take.length) continue
        left += take.readFloatLE(at)
        right += take.readFloatLE(at + 4)
      }
      block.writeFloatLE(Math.max(-1, Math.min(1, left)), i * 16)
      block.writeFloatLE(Math.max(-1, Math.min(1, right)), i * 16 + 4)
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

    // Wait for the page to say it is running: that is when the pipe starts
    // getting samples and when the measured latency is known, both of which the
    // encoder needs before it spawns.
    const running = new Promise<void>((resolve) => {
      const done = (payload: StatusPayload): void => {
        if (!payload.running && !payload.error) return
        this.off('status', done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.off('status', done)
        resolve()
      }, 4000)
      this.on('status', done)
    })

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

    await running
  }

  stop(): void {
    this.send({ type: 'stop' })
  }

  setMic(enabled: boolean, deviceId: string | null, gain: number): void {
    this.send({ type: 'mic', enabled, deviceId, gain })
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
      let chunk = this.applyAppAudio(Buffer.from(buffer))
      if (this.skipBytes > 0) {
        const drop = Math.min(this.skipBytes, chunk.length)
        this.skipBytes -= drop
        chunk = chunk.subarray(drop)
        if (chunk.length === 0) return
      }
      if (this.client) {
        this.client.write(chunk)
      } else if (this.pending.length < AudioEngine.MAX_PENDING_BLOCKS) {
        this.pending.push(chunk)
      } else {
        // Only enough to cover ffmpeg opening the pipe. Holding more means
        // replaying stale sound the moment it connects, which lands seconds of
        // old audio at the head of the recording and pushes it ahead of video.
        this.pending.shift()
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
