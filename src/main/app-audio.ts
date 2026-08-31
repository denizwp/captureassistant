import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SystemAudioMode } from '@shared/settings'

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
    const parsed = JSON.parse(stdout) as AudioApp[]
    const seen = new Set<string>()
    return parsed.filter((item) => {
      const key = item.exe.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

async function pidFor(exe: string): Promise<number | null> {
  const apps = await listAudioApps()
  const match = apps.find((item) => item.exe.toLowerCase() === exe.toLowerCase())
  return match?.pid ?? null
}

export class AppAudioCapture {
  private child: ChildProcess | null = null

  get running(): boolean {
    return this.child !== null
  }

  async start(
    mode: SystemAudioMode,
    exe: string | null,
    onData: (chunk: Buffer) => void,
    onError: (message: string) => void
  ): Promise<boolean> {
    this.stop()
    if (mode === 'all' || !exe) return false
    if (!helperAvailable()) {
      onError('Uygulama bazlı ses yakalayıcı bulunamadı.')
      return false
    }

    const pid = await pidFor(exe)
    if (pid === null) {
      onError(`${exe} şu anda ses çalmıyor, tüm sistem sesi kaydedilecek.`)
      return false
    }

    const flag = mode === 'only' ? '--include' : '--exclude'
    const child = spawn(helperPath(), [flag, String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout?.on('data', onData)

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      if (this.child !== child) return
      this.child = null
      if (code !== 0 && code !== null) {
        onError(stderr.trim().split('\n').at(-1) ?? `ses yakalayıcı ${code} ile çıktı`)
      }
    })

    return true
  }

  stop(): void {
    const child = this.child
    this.child = null
    child?.kill()
  }
}
