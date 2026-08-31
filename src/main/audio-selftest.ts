import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AUDIO_PIPE, type AudioEngine } from './audio'
import type { SettingsStore } from './store'

const run = promisify(execFile)

function ffmpegPath(): string {
  const packaged = join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  return existsSync(packaged) ? packaged : join(app.getAppPath(), 'resources', 'ffmpeg', 'ffmpeg.exe')
}

export async function runAudioSelfTest(audio: AudioEngine, store: SettingsStore): Promise<void> {
  const out = join(app.getPath('temp'), 'ca-audio-selftest.wav')

  const logPath = join(app.getPath('temp'), 'ca-audio-selftest.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => {
    appendFileSync(logPath, `${message}\n`)
  }
  log(`log: ${logPath}`)

  audio.on(
    'status',
    (payload: {
      running: boolean
      error?: string
      devices?: unknown[]
      diagnostics?: Record<string, unknown>
    }) => {
      if (payload.error) log(`renderer error: ${payload.error}`)
      else log(`renderer running=${payload.running} mics=${payload.devices?.length ?? '?'}`)
      if (payload.diagnostics) log(`diagnostics: ${JSON.stringify(payload.diagnostics)}`)
    }
  )

  const deadline = <T,>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))
    ])

  try {
    await deadline(audio.listen(), 5000, 'pipe listen')
    log(`pipe listening at ${AUDIO_PIPE}`)

    await deadline(audio.start({ ...store.get().audio, systemEnabled: true, micEnabled: true }),
      20000, 'capture page start')
    log('capture page started, giving it a moment to settle')
    await new Promise((resolve) => setTimeout(resolve, 1500))
  } catch (error) {
    log(`FAILED: ${String(error)}`)
    return
  }

  const args = [
    '-hide_banner',
    '-v', 'error',
    '-f', 'f32le',
    '-ar', '48000',
    '-ac', '4',
    '-i', AUDIO_PIPE,
    '-t', '10',
    '-c:a', 'pcm_s16le',
    '-y',
    out
  ]
  log(`ffmpeg ${args.join(' ')}`)

  const code = await new Promise<number>((resolve) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d: Buffer) => log(`ffmpeg: ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => log(`ffmpeg: ${d.toString().trim()}`))

    const kill = setTimeout(() => {
      log('ffmpeg did not finish in 25s — killing')
      child.kill()
    }, 25_000)
    child.on('close', (c) => {
      clearTimeout(kill)
      resolve(c ?? -1)
    })
  })
  log(`ffmpeg exited ${code}`)

  audio.stop()

  if (code !== 0) return

  const { stdout, stderr } = await run(ffmpegPath(), [
    '-hide_banner', '-v', 'error',
    '-i', out,
    '-af', 'channelsplit=channel_layout=4.0,astats=metadata=1:reset=0',
    '-f', 'null', '-'
  ]).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? ''
  }))

  log(`wav written to ${out}`)
  const stats = `${stdout}${stderr}`.trim()
  if (stats) log(stats)

  const { stdout: peaks } = await run(ffmpegPath(), [
    '-hide_banner',
    '-i', out,
    '-af', 'astats=metadata=1:reset=0,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level',
    '-f', 'null', '-'
  ]).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  if (peaks.trim()) log(peaks.trim())
}
