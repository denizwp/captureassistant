import { app, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Settings } from '@shared/settings'
import { INITIAL_STATE, type SupervisorState } from '@shared/state'
import { AUDIO_PIPE } from './audio'

export function ffmpegPath(): string {
  const packaged = join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  return existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg.exe')
}

/**
 * Main-process handle on the capture supervisor.
 *
 * A utilityProcess already has a direct structured-clone channel to main that
 * does not route through a renderer, so state keeps flowing while every window
 * is closed. Isolating the supervisor means a crash in the segment or assembly
 * logic cannot take the tray and the hotkeys down with it.
 */
export class SupervisorHost extends EventEmitter {
  private process: Electron.UtilityProcess | null = null
  private current: SupervisorState = INITIAL_STATE

  getState(): SupervisorState {
    return this.current
  }

  get available(): boolean {
    return existsSync(ffmpegPath())
  }

  start(settings: Settings): void {
    if (this.process) return

    const entry = join(__dirname, 'supervisor.js')
    const proc = utilityProcess.fork(entry, [], {
      serviceName: 'capture-supervisor',
      stdio: 'pipe'
    })
    this.process = proc

    // ffmpeg's own output is forwarded over the port; this only catches a
    // crash in the supervisor itself.
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.emit('log', { level: 'error', line: chunk.toString().trim() })
    })

    proc.on('exit', () => {
      this.process = null
      this.current = { ...INITIAL_STATE, lastError: 'Kayıt motoru beklenmedik şekilde kapandı.' }
      this.emit('state', this.current)
    })

    proc.on('message', (message: Record<string, unknown>) => this.receive(message))

    this.send({
      type: 'init',
      ffmpeg: ffmpegPath(),
      ringDir: settings.replay.bufferDir ?? join(app.getPath('userData'), 'ring'),
      outDir: settings.output.dir ?? join(app.getPath('videos'), 'Capture Assistant'),
      audioPipe: AUDIO_PIPE,
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
        this.emit('toast', { kind: message['kind'], message: message['message'] })
        break
      case 'log':
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
    this.send({ type: 'settings', settings })
  }

  arm(enabled: boolean): void {
    this.send({ type: 'arm', enabled })
  }

  record(start: boolean): void {
    this.send({ type: 'record', start })
  }

  saveReplay(): void {
    this.send({ type: 'save-replay' })
  }

  shutdown(): void {
    this.send({ type: 'shutdown' })
    this.process?.kill()
    this.process = null
  }
}
