import { app } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupervisorState } from '@shared/state'
import type { AudioEngine } from './audio'
import type { SettingsStore } from './store'
import type { SupervisorHost } from './supervisor'

/**
 * Arms the buffer, lets it fill, then saves a replay — the whole capture path
 * end to end without touching the UI.
 *
 * Same reasoning as the audio self-test: every stage of this chain can fail
 * quietly. An encoder that never starts, a janitor that eats its own ring, or
 * an assembler that writes a zero-byte file all look the same from outside.
 */
export async function runCaptureSelfTest(
  supervisor: SupervisorHost,
  audio: AudioEngine,
  store: SettingsStore
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

  // A short buffer keeps the test quick; the janitor still has to prune.
  const settings = store.update({ replay: { durationSec: 60, enabled: true } })
  const outDir = settings.output.dir ?? join(app.getPath('videos'), 'Capture Assistant')
  log(`output: ${outDir}`)

  supervisor.start(settings)
  await audio.start(settings.audio)
  log('arming')
  supervisor.arm(true)

  await wait(14_000)
  if (!last || (last as SupervisorState).state !== 'armed') {
    log(`FAILED: never reached armed (${(last as SupervisorState | null)?.state ?? 'no state'})`)
    return
  }

  log('saving replay')
  supervisor.saveReplay()
  await wait(12_000)

  supervisor.arm(false)
  await wait(1500)

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
