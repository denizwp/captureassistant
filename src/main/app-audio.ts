import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface AudioApp {
  pid: number
  exe: string
}

function helperPath(): string {
  const packaged = join(process.resourcesPath, 'ca-audio-capture.exe')
  return existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'ca-audio-capture.exe')
}

export function helperAvailable(): boolean {
  return existsSync(helperPath())
}

/* Only apps holding an audio session show up, which is the list worth offering. */
export async function listAudioApps(): Promise<AudioApp[]> {
  try {
    const { stdout } = await run(helperPath(), ['--list'], { timeout: 5000 })
    return JSON.parse(stdout) as AudioApp[]
  } catch {
    return []
  }
}

export async function listAudioAppNames(): Promise<string[]> {
  const seen = new Set<string>()
  for (const item of await listAudioApps()) seen.add(item.exe)
  return [...seen].sort((a, b) => a.localeCompare(b, 'tr'))
}

/*
 * Process loopback aims at one process tree per call, so covering "everything
 * except these" means running a helper for each app we do want and adding the
 * streams up. With nothing muted there is nothing to work around, and the
 * ordinary loopback stays in charge — it also picks up apps that never register
 * a session, which this path cannot see.
 */
export class AppAudioCapture {
  private readonly children = new Map<number, ChildProcess>()
  private muted: string[] = []

  get active(): boolean {
    return this.muted.length > 0
  }

  async sync(
    muted: string[],
    onData: (pid: number, chunk: Buffer) => void,
    onError: (message: string) => void,
    onGone: (pid: number) => void = () => undefined
  ): Promise<boolean> {
    this.muted = muted

    if (muted.length === 0 || !helperAvailable()) {
      if (muted.length > 0) onError('Uygulama bazlı ses yakalayıcı bulunamadı.')
      this.stop()
      return false
    }

    const blocked = new Set(muted.map((name) => name.toLowerCase()))
    const wanted = new Map<number, string>()
    for (const item of await listAudioApps()) {
      if (!blocked.has(item.exe.toLowerCase())) wanted.set(item.pid, item.exe)
    }

    for (const [pid, child] of this.children) {
      if (!wanted.has(pid)) {
        this.children.delete(pid)
        child.kill()
        onGone(pid)
      }
    }

    for (const [pid] of wanted) {
      if (this.children.has(pid)) continue
      const child = spawn(helperPath(), ['--include', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
      this.children.set(pid, child)
      child.stdout?.on('data', (chunk: Buffer) => onData(pid, chunk))
      child.on('close', () => {
        if (this.children.get(pid) !== child) return
        this.children.delete(pid)
        onGone(pid)
      })
    }

    return true
  }

  stop(): void {
    for (const child of this.children.values()) child.kill()
    this.children.clear()
    this.muted = []
  }
}
