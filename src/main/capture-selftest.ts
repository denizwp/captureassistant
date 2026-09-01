import { app } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SupervisorState } from '@shared/state'
import type { AudioEngine } from './audio'
import type { SettingsStore } from './store'
import type { SupervisorHost } from './supervisor'

const run = promisify(execFile)

function ffprobePath(): string {
  const packaged = join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe')
  return existsSync(packaged)
    ? packaged
    : join(app.getAppPath(), 'resources', 'ffmpeg', 'ffprobe.exe')
}

async function newestClip(dir: string, prefix: string): Promise<string | null> {
  const files = (await readdir(dir).catch(() => [])).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.mp4')
  )
  let newest: { path: string; at: number } | null = null
  for (const name of files) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info && (!newest || info.mtimeMs > newest.at)) newest = { path, at: info.mtimeMs }
  }
  return newest?.path ?? null
}

async function durationOf(path: string): Promise<number | null> {
  try {
    const { stdout } = await run(ffprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path
    ])
    const value = Number(stdout.trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export async function runCaptureSelfTest(
  supervisor: SupervisorHost,
  audio: AudioEngine,
  store: SettingsStore,
  startAudio: () => Promise<void>
): Promise<void> {
  const logPath = join(app.getPath('temp'), 'ca-capture-selftest.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => {
    appendFileSync(logPath, `${message}\n`)
  }
  log(`log: ${logPath}`)

  let last: SupervisorState | null = null
  supervisor.on('state', (state: SupervisorState) => {
    const summary = `state=${state.state} encoder=${state.encoder?.id ?? '-'} segments=${
      state.ring?.segmentCount ?? 0
    } buffered=${state.ring?.bufferedSec.toFixed(1) ?? 0}s disk=${mb(state.ring?.bytesOnDisk ?? 0)}`
    if (summary !== lastSummary) log(summary)
    lastSummary = summary
    last = state
  })
  let lastSummary = ''
  supervisor.on('log', (entry: { level: string; line: string }) =>
    log(`  [${entry.level}] ${entry.line}`)
  )
  supervisor.on('toast', (t: { kind: string; message: string }) => log(`  toast(${t.kind}): ${t.message}`))

  const original = store.get().replay
  // Every exit path has to put this back, or the next run reads the test's own
  // 60s as the user's setting and quietly keeps it.
  const restore = (): void => {
    store.update({ replay: { durationSec: original.durationSec, enabled: original.enabled } })
    log(`restored replay to ${original.durationSec}s, enabled=${original.enabled}`)
  }
  const settings = store.update({ replay: { durationSec: 60, enabled: true } })
  const outDir = settings.output.dir ?? join(app.getPath('videos'), 'Capture Assistant')
  log(`output: ${outDir}`)

  supervisor.start(settings)
  const starveAudio = process.argv.includes('--starve-audio')
  if (starveAudio) {
    // The pipe has to exist or ffmpeg just fails to open it. The failure worth
    // reproducing is the one where it connects and then waits forever.
    await audio.listen()
    log('DELIBERATELY serving an empty audio pipe, expecting a silent fallback')
  } else {
    // The same path the app uses, so the test exercises the real audio wiring.
    await startAudio()
  }
  log('arming')
  supervisor.arm(true)

  await wait(starveAudio ? 26_000 : 14_000)
  if (!last || (last as SupervisorState).state !== 'armed') {
    log(`FAILED: never reached armed (${(last as SupervisorState | null)?.state ?? 'no state'})`)
    restore()
    return
  }

  // The janitor sizes the ring from the supervisor's own copy of the settings.
  // If that copy says the buffer is off it prunes to the idle window instead,
  // and the ring silently stops growing around 22s no matter what is configured.
  await wait(22_000)
  const buffered = (last as SupervisorState | null)?.ring?.bufferedSec ?? 0
  log(`buffered after 36s armed: ${buffered.toFixed(1)}s`)
  if (buffered < 25) {
    log(`  FAILED: ring is capped at ${buffered.toFixed(1)}s, janitor is using the idle window`)
  } else {
    log('  OK: ring keeps growing past the idle window')
  }

  log('saving replay')
  supervisor.saveReplay()
  await wait(12_000)

  const RECORD_SEC = 10
  log(`manual recording: start, holding ${RECORD_SEC}s`)
  const startedAt = Date.now()
  supervisor.record(true)
  await wait(RECORD_SEC * 1000)
  supervisor.record(false)
  const held = (Date.now() - startedAt) / 1000
  log(`manual recording: released after ${held.toFixed(2)}s`)
  await wait(12_000)

  const recorded = await newestClip(outDir, 'Kayıt')
  if (!recorded) {
    log('FAILED: manual recording produced no clip')
  } else {
    const actual = await durationOf(recorded)
    const drift = actual === null ? null : actual - held
    log(`manual clip: ${recorded.split(/[\\/]/).at(-1)}`)
    log(`  held ${held.toFixed(2)}s, clip ${actual?.toFixed(2) ?? '?'}s, drift ${drift?.toFixed(2) ?? '?'}s`)
    if (drift !== null && Math.abs(drift) > 0.4) {
      log(`  FAILED: recording is off by ${drift.toFixed(2)}s`)
    } else if (drift !== null) {
      log('  OK: recording lines up with the button')
    }
  }

  // A fresh ffmpeg rewrites index.csv from the top with its timestamps back at
  // zero. If the ring keeps reading from its old offset it goes blind, and the
  // cut points taken from that timeline come out short and start late.
  log(`manual recording across an encoder restart, holding ${RECORD_SEC}s`)
  const restartStart = Date.now()
  supervisor.record(true)
  await wait(4000)
  await run('taskkill', ['/f', '/im', 'ffmpeg.exe']).catch(() => undefined)
  log('  killed the encoder mid-recording')
  await wait(RECORD_SEC * 1000 - 4000)
  supervisor.record(false)
  const restartHeld = (Date.now() - restartStart) / 1000
  await wait(12_000)

  const spanned = await newestClip(outDir, 'Kayıt')
  const spannedLength = spanned ? await durationOf(spanned) : null
  if (spannedLength === null) {
    log('  FAILED: no clip from a recording that spanned a restart')
  } else {
    const lost = restartHeld - spannedLength
    log(`  held ${restartHeld.toFixed(2)}s, clip ${spannedLength.toFixed(2)}s, lost ${lost.toFixed(2)}s`)
    // The outage itself is genuinely missing footage; anything beyond that is
    // the ring having lost track of where it was.
    if (lost > 3 || lost < -0.5) {
      log(`  FAILED: the ring lost ${lost.toFixed(2)}s across the restart`)
    } else {
      log('  OK: the clip survives an encoder restart')
    }
  }

  supervisor.arm(false)
  await wait(1500)

  // Recording with the buffer off starts the encoder from nothing, which is a
  // different path from recording out of a ring that is already turning.
  log('manual recording with the buffer off')
  let outages = 0
  const countOutage = (entry: { line: string }): void => {
    if (entry.line.includes('screen capture lost')) outages += 1
  }
  supervisor.on('log', countOutage)
  supervisor.record(true)
  // The encoder is cold here and only reports 'recording' once it is actually
  // rolling, so time the hold from that rather than from the request.
  const rollingBy = Date.now() + 8000
  while ((last as SupervisorState | null)?.state !== 'recording' && Date.now() < rollingBy) {
    await wait(100)
  }
  const coldStart = Date.now()
  await wait(RECORD_SEC * 1000)
  supervisor.record(false)
  const coldHeld = (Date.now() - coldStart) / 1000
  await wait(12_000)

  supervisor.off('log', countOutage)
  const cold = await newestClip(outDir, 'Kayıt')
  const coldLength = cold ? await durationOf(cold) : null
  if (coldLength === null) {
    log('  FAILED: no clip from a cold manual recording')
  } else {
    const drift = coldLength - coldHeld
    log(`  held ${coldHeld.toFixed(2)}s, clip ${coldLength.toFixed(2)}s, drift ${drift.toFixed(2)}s`)
    // Each time the duplication is lost the screen genuinely is not being
    // captured, so allow for the outages this run actually saw.
    const allowance = 0.6 + outages * 1.8
    log(
      Math.abs(drift) > allowance
        ? `  FAILED: cold recording is off by more than the ${outages} outage(s) explain`
        : '  OK: cold recording lines up'
    )
    log(`  (encoder warm-up excluded from the hold, ${outages} capture outage(s) during it)`)
  }

  restore()

  const files = await readdir(outDir).catch(() => [])
  const clips = files.filter((f) => f.endsWith('.mp4'))
  log(`clips in output: ${clips.length}`)
  for (const clip of clips.slice(-3)) {
    const info = await stat(join(outDir, clip)).catch(() => null)
    log(`  ${clip} — ${mb(info?.size ?? 0)}`)
  }
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)}MB`
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
