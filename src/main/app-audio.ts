import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function helperPath(): string {
  const packaged = join(process.resourcesPath, 'ca-audio-capture.exe')
  return existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'ca-audio-capture.exe')
}

export function helperAvailable(): boolean {
  return existsSync(helperPath())
}

/*
 * All system audio comes through here rather than Chromium's loopback. Chromium
 * buffers around 200ms before we ever see a sample and ffmpeg stamps audio when
 * it arrives, so that delay lands in the recording with no way to take it back
 * out downstream. WASAPI hands us the same audio a frame or two after it plays.
 *
 * Process loopback aims at one process tree per call. Excluding our own tree
 * gets everything; muting apps means running a helper per app we still want and
 * adding the streams up.
 */
export class AppAudioCapture {
  private readonly children = new Map<number, ChildProcess>()
  /*
   * A helper can die under us — a device change, a driver update, an access
   * violation deep in the audio stack. It used to be reported and then simply
   * left dead, so the rest of a session recorded silently while everything
   * looked fine. It is brought back instead, backing off if it will not stay
   * up, and giving up loudly rather than spinning.
   */
  private wanted = false
  private failures = 0
  private retry: NodeJS.Timeout | null = null
  private hands: {
    onData: (pid: number, chunk: Buffer) => void
    onError: (message: string) => void
    onGone: (pid: number) => void
  } | null = null

  get active(): boolean {
    return this.children.size > 0
  }

  async sync(
    onData: (pid: number, chunk: Buffer) => void,
    onError: (message: string) => void,
    onGone: (pid: number) => void = () => undefined
  ): Promise<boolean> {
    this.wanted = true
    this.hands = { onData, onError, onGone }
    if (!helperAvailable()) {
      onError('Ses yakalayıcı bulunamadı.')
      this.stop()
      return false
    }

    // Excluding our own tree captures everything else on the machine, including
    // apps that never register an audio session.
    const wanted = new Map<number, string[]>([
      [process.pid, ['--exclude', String(process.pid)]]
    ])

    for (const [pid, child] of this.children) {
      if (!wanted.has(pid)) {
        this.children.delete(pid)
        child.kill()
        onGone(pid)
      }
    }

    for (const [pid, args] of wanted) {
      if (this.children.has(pid)) continue
      const child = spawn(helperPath(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.children.set(pid, child)
      const startedAt = Date.now()
      child.stdout?.on('data', (chunk: Buffer) => onData(pid, chunk))

      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => onError(`ses yakalayıcı başlatılamadı: ${error.message}`))
      child.on('close', (code) => {
        if (this.children.get(pid) !== child) return
        this.children.delete(pid)
        onGone(pid)
        if (!code) return
        onError(`ses yakalayıcı durdu (${code}): ${stderr.trim().slice(0, 120)}`)
        // One that ran for a while and then died is a one-off; one that dies
        // immediately, over and over, is not going to start.
        if (Date.now() - startedAt > 30_000) this.failures = 0
        this.relaunch()
      })
    }

    return true
  }

  private relaunch(): void {
    const hands = this.hands
    if (!this.wanted || !hands || this.retry) return

    this.failures++
    if (this.failures > 4) {
      hands.onError('Ses yakalayıcı sürekli kapanıyor — görüntü sessiz kaydediliyor.')
      return
    }

    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.wanted) return
      void this.sync(hands.onData, hands.onError, hands.onGone).catch(() => undefined)
    }, 1000 * this.failures)
  }

  stop(): void {
    this.wanted = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.failures = 0
    for (const child of this.children.values()) child.kill()
    this.children.clear()
  }
}
