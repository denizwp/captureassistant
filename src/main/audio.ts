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
  private devices: MicDevice[] = []
  private appAudio = new Map<number, Buffer>()
  private appAudioActive = false
  private systemGain = 1
  private systemPeak = 0
  private mic: Buffer[] = []
  private micBytes = 0
  private pump: NodeJS.Timeout | null = null
  private owedFrom = 0
  private sentFrames = 0


  constructor(private readonly preload = join(__dirname, '../preload/audio.js')) {
    super()
    this.registerIpc()
  }

  getDevices(): MicDevice[] {
    return this.devices
  }

  /*
   * The pipe is clocked here, off the wall clock, rather than by whatever
   * arrives from the capture page. ffmpeg reads video and audio through one
   * scheduler: when the audio side falls behind real time it holds the whole
   * graph back, ddagrab stops being polled, and the screen capture collapses
   * with it — measured at 58 fps down to 2 fps for an audio feed a third of a
   * second late. Sources that are late are padded with silence instead.
   */
  private static readonly FRAME_BYTES = 16

  private static readonly RATE = 48_000

  private static readonly PUMP_MS = 10

  /* Roughly 200ms per source. Past that, older audio is lag, not content. */
  private static readonly MAX_QUEUE_BYTES = 48_000 * 2 * 4 * 0.2

  private static readonly MAX_MIC_BYTES = 48_000 * 4 * 4 * 0.2

  setSystemGain(gain: number): void {
    this.systemGain = Math.max(0, gain)
  }

  /* Feeds the meter, since these samples never pass through the capture page. */
  takeSystemPeak(): number {
    const peak = this.systemPeak
    this.systemPeak = 0
    return peak > 0 ? Math.max(-100, 20 * Math.log10(peak)) : -100
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

  private pushMic(chunk: Buffer): void {
    this.mic.push(chunk)
    this.micBytes += chunk.length
    while (this.micBytes > AudioEngine.MAX_MIC_BYTES && this.mic.length > 1) {
      this.micBytes -= this.mic.shift()!.length
    }
  }

  private takeMic(bytes: number): Buffer {
    if (bytes <= 0 || this.mic.length === 0) return Buffer.alloc(0)
    const joined = this.mic.length === 1 ? this.mic[0]! : Buffer.concat(this.mic, this.micBytes)
    const usable = Math.min(bytes, joined.length - (joined.length % AudioEngine.FRAME_BYTES))
    const rest = joined.subarray(usable)
    this.mic = rest.length ? [rest] : []
    this.micBytes = rest.length
    return joined.subarray(0, usable)
  }

  private startPump(): void {
    this.stopPump()
    this.owedFrom = Date.now()
    this.sentFrames = 0
    this.pump = setInterval(() => this.emitOwed(), AudioEngine.PUMP_MS)
  }

  private stopPump(): void {
    if (this.pump) clearInterval(this.pump)
    this.pump = null
    this.mic = []
    this.micBytes = 0
  }

  /*
   * Emit exactly as many frames as the clock says are due. Timers on Windows
   * round up to ~15ms, so this has to work from elapsed time rather than a
   * fixed block per tick or the pipe quietly runs a third slow.
   */
  private emitOwed(): void {
    const client = this.client
    if (!client) return

    const due = Math.floor(((Date.now() - this.owedFrom) / 1000) * AudioEngine.RATE)
    let frames = due - this.sentFrames
    if (frames <= 0) return
    // After a long stall, catching up in full would dump a burst of silence
    // into the recording; skip the gap instead.
    const cap = AudioEngine.RATE / 2
    if (frames > cap) frames = cap
    this.sentFrames = due

    const block = Buffer.alloc(frames * AudioEngine.FRAME_BYTES)
    const mic = this.takeMic(frames * AudioEngine.FRAME_BYTES)
    mic.copy(block, 0, 0, mic.length)
    this.mixSystem(block, frames)
    client.write(block)
  }

  /* Helper streams are stereo; they land on channels 0 and 1, mic keeps 2 and 3. */
  private mixSystem(block: Buffer, frames: number): void {
    if (!this.appAudioActive) return

    const wanted = frames * 8
    const takes: Buffer[] = []
    for (const [source, queued] of this.appAudio) {
      const usable = Math.min(wanted, queued.length - (queued.length % 8))
      takes.push(queued.subarray(0, usable))
      this.appAudio.set(source, queued.subarray(usable))
    }
    if (takes.length === 0) return

    for (let i = 0; i < frames; i++) {
      let left = 0
      let right = 0
      const at = i * 8
      for (const take of takes) {
        if (at + 8 > take.length) continue
        left += take.readFloatLE(at)
        right += take.readFloatLE(at + 4)
      }
      left = Math.max(-1, Math.min(1, left * this.systemGain))
      right = Math.max(-1, Math.min(1, right * this.systemGain))
      const loudest = Math.max(Math.abs(left), Math.abs(right))
      if (loudest > this.systemPeak) this.systemPeak = loudest
      block.writeFloatLE(left, i * 16)
      block.writeFloatLE(right, i * 16 + 4)
    }
  }

  async listen(): Promise<void> {
    if (this.server) return
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.client = socket
        // The clock starts when ffmpeg connects, so nothing recorded before it
        // opened the pipe can land at the head of the take.
        this.startPump()
        socket.on('error', () => undefined)
        socket.on('close', () => {
          if (this.client !== socket) return
          this.client = null
          this.stopPump()
        })
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
    this.stopPump()
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
      this.pushMic(Buffer.from(buffer))
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
