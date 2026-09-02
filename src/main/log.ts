import { app, screen } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { release, totalmem } from 'node:os'
import { statfs } from 'node:fs/promises'
import type { Settings } from '@shared/settings'

const run = promisify(execFile)

const MAX_BYTES = 2 * 1024 ** 2

export function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

export function logPath(): string {
  return join(logDir(), 'capture-assistant.log')
}

/*
 * One file the user can hand over when something goes wrong. It has to survive
 * a restart, so it does not live in %TEMP%, and it has to stay small enough to
 * attach, so it rolls over into a single previous copy.
 */
export function write(line: string): void {
  const path = logPath()
  try {
    mkdirSync(logDir(), { recursive: true })
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (size > MAX_BYTES) renameSync(path, `${path}.old`)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

export function logEntry(level: string, line: string): void {
  write(`[${level}] ${line}`)
}

async function freeSpace(path: string): Promise<string> {
  try {
    const info = await statfs(path)
    return `${((info.bavail * info.bsize) / 1024 ** 3).toFixed(1)}GB free`
  } catch {
    return 'unknown'
  }
}

async function gpus(): Promise<string> {
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) driver $($_.DriverVersion)" }'
      ],
      { timeout: 10_000 }
    )
    return stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' | ') || 'unknown'
  } catch {
    return 'unknown'
  }
}

/*
 * Written once per launch. Nearly every report so far turned on something in
 * here — which display, which GPU, how full the disk is — so it is worth the
 * one-off cost of collecting it.
 */
export async function writeHeader(settings: Settings, ringDir: string, outDir: string): Promise<void> {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay().id
  const c = settings.capture

  // Collected first and written in one go: the parts that need a subprocess
  // take a second, and interleaving them with startup logs makes the header
  // hard to read at exactly the moment someone is trying to read it.
  const lines = [
    '',
    `=== Capture Assistant ${app.getVersion()} ===`,
    `windows ${release()} | electron ${process.versions.electron} | ram ${(totalmem() / 1024 ** 3).toFixed(0)}GB`,
    `gpu: ${await gpus()}`,
    `displays: ${displays.length}`,
    ...displays.map(
      (d, i) =>
        `  [${i}] ${d.bounds.width}x${d.bounds.height} @${d.displayFrequency}Hz ` +
        `at ${d.bounds.x},${d.bounds.y} scale ${d.scaleFactor}` +
        `${d.id === primary ? ' primary' : ''} ${d.colorSpace}`
    ),
    `capture: ${c.method} | monitor ${c.monitorId ?? 'auto'} ${c.fps}fps ${c.codec} ${c.preset} bitrate ${c.bitrateKbps || 'auto'}`,
    `replay: ${settings.replay.enabled ? 'on' : 'off'} ${settings.replay.durationSec}s +${settings.replay.postRollSec}s`,
    `audio: system ${settings.audio.systemEnabled ? 'on' : 'off'} gain ${settings.audio.systemGain} | ` +
      `mic ${settings.audio.micEnabled ? 'on' : 'off'} gain ${settings.audio.micGain} device ${settings.audio.micDeviceId ?? 'default'}`,
    `ring: ${ringDir} (${await freeSpace(ringDir)})`,
    `output: ${outDir} (${await freeSpace(outDir)})`
  ]
  for (const line of lines) write(line)
}
