import { app, screen } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
/* Local time with the offset: the log has to line up with the clip filenames. */
function stamp(): string {
  const now = new Date()
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offset) / 60))}`
  )
}

export function write(line: string): void {
  const path = logPath()
  try {
    mkdirSync(logDir(), { recursive: true })
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (size > MAX_BYTES) renameSync(path, `${path}.old`)
    appendFileSync(path, `${stamp()} ${line}\n`)
  } catch {}
}

/*
 * A file that exists only while the app is up.
 *
 * It is written on start and removed on a clean quit, so finding one already
 * there means the previous run never got to shut down — a crash, a forced kill,
 * or the machine going off. That is the single most useful thing to know when
 * reading a log afterwards, and nothing else in the log says it: a run that
 * dies leaves no closing line, which is indistinguishable from a run that is
 * still going.
 */
function sessionMarkerPath(): string {
  return join(logDir(), 'session.open')
}

export function openSession(): { previousRunCrashed: boolean } {
  let previousRunCrashed = false
  try {
    mkdirSync(logDir(), { recursive: true })
    previousRunCrashed = !!statSync(sessionMarkerPath(), { throwIfNoEntry: false })
    writeFileSync(sessionMarkerPath(), new Date().toISOString())
  } catch {}

  if (previousRunCrashed) {
    write('previous run did not shut down cleanly — everything above is from it')
  }
  write(`session start, version ${app.getVersion()}`)
  return { previousRunCrashed }
}

export function closeSession(): void {
  write('session end')
  try {
    unlinkSync(sessionMarkerPath())
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

/*
 * One shell for the lot. Each of these has explained a report at some point and
 * none can be read from inside Electron, but spawning powershell once per item
 * would put seconds between launching and recording.
 */
const PROBE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-CimInstance Win32_VideoController | ForEach-Object { "gpu=$($_.Name) driver $($_.DriverVersion)" }',
  '$c = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '"cpu=$($c.Name) $($c.NumberOfCores)c/$($c.NumberOfLogicalProcessors)t"',
  "'hags=' + $((Get-ItemProperty 'HKLM:/SYSTEM/CurrentControlSet/Control/GraphicsDrivers').HwSchMode)",
  "'mpo-testmode=' + $((Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows/Dwm').OverlayTestMode)",
  '"elevated=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"',
  'Get-PhysicalDisk | ForEach-Object { "disk=$($_.DeviceId) $($_.MediaType) $($_.BusType)" }',
  '$rivals = "obs64","obs32","nvcontainer","OverwolfLauncher","ShareX","Bandicam","Recordly"',
  'Get-Process | Where-Object { $rivals -contains $_.ProcessName } | Group-Object ProcessName | ForEach-Object { "other-capture=$($_.Name) x$($_.Count)" }'
].join('; ')

async function systemProbe(): Promise<string[]> {
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', PROBE_SCRIPT], {
      timeout: 15_000
    })
    return stdout
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter(Boolean)
      // A registry value that was never written comes back blank, which reads
      // as a failed probe rather than as the default it actually is.
      .map((line) => (line.endsWith('=') ? `${line}default (not set)` : line))
  } catch {
    return ['gpu=unknown']
  }
}

/*
 * Written once per launch. Nearly every report so far turned on something in
 * here — which display, which GPU, how full the disk is — so it is worth the
 * one-off cost of collecting it.
 */
export async function writeHeader(settings: Settings, ringDir: string, outDir: string): Promise<void> {
  // Opens the file before anything else can log into it, so a report starts
  // with what it is a report about; the probed details follow a second later.
  write('')
  write(`=== Capture Assistant ${app.getVersion()} ===`)
  write(`windows ${release()} | electron ${process.versions.electron} | ram ${(totalmem() / 1024 ** 3).toFixed(0)}GB`)

  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay().id
  const c = settings.capture

  // Collected first and written in one go: the parts that need a subprocess
  // take a second, and interleaving them with startup logs makes the header
  // hard to read at exactly the moment someone is trying to read it.
  const lines = [
    ...(await systemProbe()),
    `displays: ${displays.length}`,
    ...displays.map(
      (d, i) =>
        `  [${i}] ${d.bounds.width}x${d.bounds.height} @${d.displayFrequency}Hz ` +
        `at ${d.bounds.x},${d.bounds.y} scale ${d.scaleFactor}` +
        `${d.id === primary ? ' primary' : ''} ${d.colorSpace}`
    ),
    `capture: monitor ${c.monitorId ?? 'auto'} ${c.fps}fps ${c.codec} ${c.preset} bitrate ${c.bitrateKbps || 'auto'}`,
    `replay: ${settings.replay.enabled ? 'on' : 'off'} ${settings.replay.durationSec}s +${settings.replay.postRollSec}s`,
    `audio: system ${settings.audio.systemEnabled ? 'on' : 'off'} gain ${settings.audio.systemGain} | ` +
      `mic ${settings.audio.micEnabled ? 'on' : 'off'} gain ${settings.audio.micGain} device ${settings.audio.micDeviceId ?? 'default'}`,
    `ring: ${ringDir} (${await freeSpace(ringDir)})`,
    `output: ${outDir} (${await freeSpace(outDir)})`
  ]
  for (const line of lines) write(line)
}
