import { app, screen, utilityProcess } from 'electron'
import { appendFileSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/settings'
import { INITIAL_STATE, type SupervisorState } from '@shared/state'
import { AUDIO_PIPE } from './audio'

/**
 * Electron gives display ids; ddagrab wants a DXGI output index. There is no
 * API that maps between them, but DXGI enumerates outputs in desktop layout
 * order, so position in a left-to-right, top-to-bottom sort is the closest
 * thing to a mapping without a native module.
 */
export function outputIndexFor(monitorId: string | null): number {
  const displays = [...screen.getAllDisplays()].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
  )
  if (!monitorId) {
    const primary = screen.getPrimaryDisplay().id
    return Math.max(0, displays.findIndex((d) => d.id === primary))
  }
  return Math.max(0, displays.findIndex((d) => String(d.id) === monitorId))
}

export function ffmpegPath(): string {
  const packaged = join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  return existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg.exe')
}

/** The supervisor failing is invisible from the UI — the buffer just never
 *  fills — so its exit codes and stderr always go to a file. */
function trace(message: string): void {
  try {
    appendFileSync(
      join(tmpdir(), 'ca-supervisor.log'),
      `${new Date().toISOString()} ${message}
`
    )
  } catch {}
}

export class SupervisorHost extends EventEmitter {
  private process: Electron.UtilityProcess | null = null
  private current: SupervisorState = INITIAL_STATE
  private settings: Settings | null = null
  private stopped = false
  private restarts = 0

  getState(): SupervisorState {
    return this.current
  }

  get available(): boolean {
    return existsSync(ffmpegPath())
  }

  start(settings: Settings): void {
    if (this.process) return
    this.settings = settings
    this.stopped = false

    // utilityProcess.fork needs a path it can actually open, and __dirname is
    // inside app.asar in a packaged build. electron-builder puts a real copy in
    // app.asar.unpacked for exactly this.
    const entry = join(__dirname, 'supervisor.js').replace(
      `${sep}app.asar${sep}`,
      `${sep}app.asar.unpacked${sep}`
    )
    trace(`fork entry: ${entry} exists=${existsSync(entry)}`)
    const proc = utilityProcess.fork(entry, [], {
      serviceName: 'capture-supervisor',
      stdio: 'pipe'
    })
    this.process = proc

    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      trace(`stderr: ${line}`)
      this.emit('log', { level: 'error', line })
    })
    proc.stdout?.on('data', (chunk: Buffer) => trace(`stdout: ${chunk.toString().trim()}`))

    proc.on('exit', (code) => {
      trace(`exit code=${code} restarts=${this.restarts}`)
      this.process = null
      if (this.stopped) return

      this.restarts += 1
      const giveUp = this.restarts > 5
      this.current = {
        ...INITIAL_STATE,
        lastError: giveUp
          ? 'Kayıt motoru sürekli kapanıyor.'
          : 'Kayıt motoru kapandı, yeniden başlatılıyor…'
      }
      this.emit('state', this.current)
      this.emit('log', { level: 'error', line: `supervisor exited (${code})` })

      if (giveUp) return
      setTimeout(() => {
        const settings = this.settings
        if (settings && !this.stopped) this.start(settings)
      }, 1000 * this.restarts)
    })

    proc.on('message', (message: Record<string, unknown>) => this.receive(message))

    this.send({
      type: 'init',
      ffmpeg: ffmpegPath(),
      ringDir: settings.replay.bufferDir ?? join(app.getPath('userData'), 'ring'),
      outDir: settings.output.dir ?? join(app.getPath('videos'), 'Capture Assistant'),
      audioPipe: AUDIO_PIPE,
      outputIdx: outputIndexFor(settings.capture.monitorId),
      settings
    })
  }

  private receive(message: Record<string, unknown>): void {
    switch (message['type']) {
      case 'state':
        this.current = message['state'] as SupervisorState
        this.emit('state', this.current)
        break
      case 'toast':
        trace(`toast(${String(message['kind'])}): ${String(message['message'])}`)
        this.emit('toast', { kind: message['kind'], message: message['message'] })
        break
      case 'log':
        trace(`[${String(message['level'])}] ${String(message['line'])}`)
        this.emit('log', { level: message['level'], line: message['line'] })
        break
      case 'clip':
        this.emit('clip', message)
        break
    }
  }

  private send(message: unknown): void {
    this.process?.postMessage(message)
  }

  updateSettings(settings: Settings): void {
    this.settings = settings
    this.send({
      type: 'settings',
      settings,
      outputIdx: outputIndexFor(settings.capture.monitorId)
    })
  }

  arm(enabled: boolean): void {
    trace(`arm(${enabled}) process=${this.process ? 'alive' : 'null'}`)
    this.send({ type: 'arm', enabled })
  }

  record(start: boolean): void {
    this.send({ type: 'record', start })
  }

  saveReplay(): void {
    this.send({ type: 'save-replay' })
  }

  shutdown(): void {
    this.stopped = true
    this.send({ type: 'shutdown' })
    this.process?.kill()
    this.process = null
  }
}
