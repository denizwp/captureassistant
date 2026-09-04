import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import type { CaptureState, SupervisorState } from '@shared/state'
import { assemble } from './assembler'
import { appendSegmentLine, buildNativeArgs, createNativeReader,
  NATIVE_EXIT_SETUP, NATIVE_EXIT_SIZE_CHANGED } from './native'
import { PRESET_MAXRATE_KBPS, SEGMENT_SEC, type EncoderChoice } from './pipeline'
import { Ring, sweepOrphans } from './ring'

interface InitMessage {
  type: 'init'
  capture: string
  mux: string
  ringDir: string
  outDir: string
  audioPipe: string
  outputIdx: number
  settings: Settings
}

type Incoming =
  | InitMessage
  | {
      type: 'settings'
      settings: Settings
      outputIdx?: number
      ringDir?: string
      outDir?: string
    }
  | { type: 'arm'; enabled: boolean }
  | { type: 'record'; start: boolean }
  | { type: 'save-replay' }
  | { type: 'shutdown' }

const DISK_HEADROOM_BYTES = 5 * 1024 ** 3

let settings: Settings | null = null
let capturePath = ''
let muxPath = ''
let ringDir = ''
let outDir = ''
let audioPipe = ''
let audioDisabled = false
let bufferArmed = false
let outputIdx = 0
let ring: Ring | null = null
let encoder: EncoderChoice | null = null

let child: ChildProcess | null = null
let restarting = false
let stopping = false
let consecutiveFailures = 0
let startedAt = 0

const HEALTHY_RUN_MS = 5000
const MAX_FAST_FAILURES = 4

let state: CaptureState = 'idle'
let recordStart: number | null = null
let recordStartedAt = 0
let lastError: string | null = null

const port = process.parentPort

function send(message: unknown): void {
  port?.postMessage(message)
}

function log(line: string, level: 'info' | 'warning' | 'error' | 'success' = 'info'): void {
  send({ type: 'log', level, line })
}

function toast(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
  send({ type: 'toast', kind, message })
}

async function publish(): Promise<void> {
  const payload: SupervisorState = {
    state,
    recordingElapsedSec:
      state === 'recording' ? Math.max(0, (Date.now() - recordStartedAt) / 1000) : 0,
    micActive: state !== 'idle' && !!settings?.audio.micEnabled,
    encoder: encoder
      ? { id: encoder.id, vendor: vendorOf(encoder.id), hardware: encoder.hardware }
      : null,
    ring: ring ? await ring.stats() : null,
    lastError
  }
  send({ type: 'state', state: payload })
}

function vendorOf(id: string): 'nvidia' | 'amd' | 'intel' | 'software' {
  if (id.endsWith('_nvenc')) return 'nvidia'
  if (id.endsWith('_amf')) return 'amd'
  if (id.endsWith('_qsv')) return 'intel'
  // Media Foundation picks the card's own encoder and never says whose it is,
  // so the badge shows it as hardware without claiming a make.
  return 'nvidia'
}

async function startEncoder(): Promise<void> {
  if (child || !settings || !ring || !encoder) return

  await mkdir(ringDir, { recursive: true })

  const args = buildNativeArgs({
    capture: settings.capture,
    outputIdx,
    ringDir,
    startNumber: ring.nextSegmentNumber,
    drawMouse: true,
    audioPipe: audioDisabled ? null : audioPipe
  })

  await ring.beginRun({
    width: 0,
    height: 0,
    fps: settings.capture.fps,
    codec: 'native',
    hasAudio: !audioDisabled
  })

  // The exact command, once per run: without it a report cannot be told apart
  // from one where the arguments themselves were wrong.
  log(`ca-capture ${args.join(' ')}`)

  const proc = spawn(capturePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  startedAt = Date.now()
  /*
   * The engine spends a second or so building its capture session and counts
   * its own timeline from the end of that. Anchoring the ring at spawn would
   * leave the clock running ahead of the segments by exactly that setup time,
   * and every cut point taken from it lands past what was written.
   */
  const anchor = (): void => {
    if (!ring) return
    const shift = ring.markEncoderStart()
    if (recordStart !== null) recordStart += shift
  }
  log('encoder started (ca-capture)', 'success')

  /*
   * The engine names each finished segment on stdout, and those lines go into
   * index.csv. The ring, the janitor and every cut point read that file and
   * never need to know what produced it.
   */
  let lastStats = 0
  const read = createNativeReader({
    onReady: (line) => {
      anchor()
      log(line)
    },
    onSegment: (line) => {
      void appendSegmentLine(ringDir, line).catch((error: unknown) =>
        log(`could not record segment: ${String(error)}`, 'error')
      )
    },
    onStats: (stats) => {
      const now = Date.now()
      if (now - lastStats < 30_000) return
      lastStats = now
      const target = settings?.capture.fps ?? 60
      const rate = stats.wall > 0 ? stats.frames / stats.wall : 0
      // A timeline in the log is the only way to tell afterwards whether a clip
      // came out choppy because the screen was never sampled.
      log(
        `capture ${rate.toFixed(1)}/${target} fps, ` +
          `${stats.produced.toFixed(2)}s of ${stats.wall.toFixed(2)}s wall` +
          ` (${stats.dropped} dropped, ${stats.rejected} rejected)`
      )
    }
  })
  proc.stdout?.on('data', (chunk: Buffer) => read(chunk.toString()))

  // A spawn that never gets off the ground emits 'error', and an 'error' with
  // no listener is thrown: the whole supervisor would go down over a missing or
  // blocked engine. 'close' still follows, so the restart path handles it.
  proc.on('error', (error) => log(`the engine could not start: ${error.message}`, 'error'))

  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderr = `${stderr}${text}`.slice(-2000)
    for (const line of text.split('\n')) {
      if (line.trim()) log(`engine: ${line.trim()}`, 'warning')
    }
  })

  proc.on('close', (code) => {
    child = null
    if (stopping || state === 'idle') return

    /*
     * The engine could not build a capture session at all. Retrying cannot help
     * — the screen, the driver or the encoder is refusing — and there is no
     * second pipeline to fall back to, so say so once instead of looping.
     */
    if (code === NATIVE_EXIT_SETUP) {
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
      state = 'idle'
      bufferArmed = false
      fail(
        'Ekran yakalanamadı. Ekran kartı sürücüsünü güncellemeyi dene' +
          (detail ? ` (${detail.slice(0, 120)})` : '') + '.'
      )
      return
    }

    const lived = Date.now() - startedAt
    // The display changing size is the engine's way of asking to be rebuilt,
    // which says nothing about whether it works. It counts towards neither the
    // give-up counter nor the back-off.
    const rebuild = code === NATIVE_EXIT_SIZE_CHANGED
    consecutiveFailures = rebuild || lived >= HEALTHY_RUN_MS ? 0 : consecutiveFailures + 1

    if (consecutiveFailures > MAX_FAST_FAILURES) {
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? `çıkış kodu ${code}`
      state = 'idle'
      bufferArmed = false
      fail(`Kayıt motoru başlatılamıyor: ${detail.slice(0, 200)}`)
      return
    }

    if (code === NATIVE_EXIT_SIZE_CHANGED) log('display size changed — rebuilding capture')
    else log(`encoder exited (${code}) after ${(lived / 1000).toFixed(1)}s — restarting`, 'warning')
    if (restarting) return
    restarting = true

    // Every millisecond here is a hole in the buffer, and the duplication is
    // ready again as soon as the compositor settles.
    const delay = rebuild ? 0 : Math.min(400 * 2 ** consecutiveFailures, 5000)
    setTimeout(() => {
      restarting = false
      void startEncoder().catch((error: unknown) => fail(String(error)))
    }, delay)
  })
}

async function stopEncoder(): Promise<void> {
  const proc = child
  stopping = true
  child = null

  if (proc && proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(force)
        resolve()
      }

      const force = setTimeout(() => {
        proc.kill('SIGKILL')
        setTimeout(resolve, 500)
      }, 2000)
      proc.once('close', done)
      proc.kill()
    })
  }

  stopping = false
}

let errorTimer: NodeJS.Timeout | null = null

function fail(message: string): void {
  lastError = message
  log(message, 'error')
  toast('error', message)
  void publish()

  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => {
    errorTimer = null
    lastError = null
    void publish()
  }, 6000)
}

const STALL_SEC = 10

/*
 * ffmpeg reads the audio pipe as an input, so if nothing ever writes to it the
 * whole graph waits forever: no segments, no error, no exit. That looks exactly
 * like a working buffer that never fills, so treat a silent ring as a broken
 * audio source and come back without it rather than sit there.
 */
/*
 * One of the streams never produced a packet. Sound is the half that can be
 * dropped and still leave a usable recording, so try that first; after that the
 * screen is the only suspect left, and the display the probe picked may simply
 * have stopped working, so scan for one that does.
 */
async function watchForStall(): Promise<void> {
  if (!ring || !child || startedAt === 0) return
  if (ring.newestEnd > 0) return
  if ((Date.now() - startedAt) / 1000 < STALL_SEC) return

  if (!audioDisabled) {
    audioDisabled = true
    log('no segments and no audio arriving, restarting without sound', 'warning')
    toast('warning', 'Ses yakalanamadı — görüntü sessiz kaydediliyor.')
    await stopEncoder()
    await startEncoder()
    return
  }

  log('encoder produced nothing, giving up', 'error')
  toast('error', 'Ekran kaydı başlatılamadı.')
  await setArmed(false)
}

async function tick(): Promise<void> {
  if (!ring || !settings || state === 'idle') return

  await ring.poll()
  await ring.measure()
  await watchForStall()

  // Being armed is what "the buffer is on" means. Reading it off the settings
  // instead lets a stale copy shrink the ring to the idle window while the user
  // watches it sit at twenty seconds.
  const keep = bufferArmed
    ? settings.replay.durationSec + settings.replay.postRollSec
    : SEGMENT_SEC * 4
  await ring.prune(keep)

  await diskGuard()
  await publish()
}

async function diskGuard(): Promise<void> {
  if (!ring || !settings) return
  const stats = await ring.stats()
  const maxrateKbps =
    settings.capture.bitrateKbps > 0
      ? settings.capture.bitrateKbps
      : PRESET_MAXRATE_KBPS[settings.capture.preset]
  const worstCase = ((maxrateKbps + 512) * 1000 * settings.replay.durationSec) / 8
  const required = Math.max(DISK_HEADROOM_BYTES, worstCase * 0.5)

  if (stats.freeDiskBytes > 0 && stats.freeDiskBytes < required) {
    toast('warning', 'Disk doluyor — geçmiş kayıt durduruldu.')
    log(
      `disk guard tripped, disarming: ${(stats.freeDiskBytes / 1024 ** 3).toFixed(1)}GB free, ` +
        `${(required / 1024 ** 3).toFixed(1)}GB needed`,
      'error'
    )
    await setArmed(false)
  }
}

async function ensureEncoder(): Promise<boolean> {
  if (encoder || !settings) return !!encoder

  /*
   * The native engine finds its own hardware encoder through Media Foundation
   * and never goes near Desktop Duplication. Probing that here would turn a
   * machine whose duplication is broken away at the door — which is the exact
   * machine this engine exists for.
   */
  if (!capturePath) {
    fail('Yakalama motoru bulunamadı. Uygulamayı yeniden kurmak gerekiyor.')
    return false
  }

  encoder = {
    id: settings.capture.codec === 'hevc' ? 'hevc' : 'h264',
    hardware: true
  }
  log(`using ${encoder.id}`, 'success')
  return true
}

async function setArmed(enabled: boolean): Promise<void> {
  if (!settings) return
  bufferArmed = enabled

  if (enabled) {
    if (state !== 'idle') return
    if (!(await ensureEncoder())) return
    ring = new Ring(ringDir)
    await mkdir(ringDir, { recursive: true })
    await ring.reset()
    state = 'armed'
    lastError = null
    consecutiveFailures = 0
    audioDisabled = false
    await startEncoder()
  } else {
    if (state === 'recording') await stopRecording()
    state = 'idle'
    await stopEncoder()
    await ring?.prune(0)
    ring = null
  }
  await publish()
}

async function startRecording(): Promise<void> {
  if (!settings) return
  if (state === 'recording') return

  if (state === 'idle') {
    if (!(await ensureEncoder())) return
    ring = new Ring(ringDir)
    await mkdir(ringDir, { recursive: true })
    await ring.reset()
    await startEncoder()

    // Nothing exists until ffmpeg has written its first segment, so start the
    // clock from there. Counting from the keypress instead would promise a
    // second of footage that was never captured.
    const deadline = Date.now() + 6000
    while (ring.newestEnd <= 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await ring.poll()
    }
  }

  recordStart = ring?.liveEnd ?? 0
  recordStartedAt = Date.now()
  ring?.pin(ring.nextSegmentNumber, null, 'recording')
  state = 'recording'
  log('recording started', 'success')
  await publish()
}

async function stopRecording(): Promise<void> {
  if (state !== 'recording' || !ring || !settings || !encoder) return

  // Catch the reader up first so the clock is measured against segments that
  // exist, then read the cut points before anything else is awaited or the clip
  // drifts behind whatever the wait costs us.
  await ring.poll()
  const from = recordStart ?? 0
  const to = ring.liveEnd
  recordStart = null
  state = bufferArmed ? 'armed' : 'idle'
  await publish()

  await waitForSegment(to)
  ring.unpin('recording')

  await buildClip(from, to, 'Kayıt')

  if (!bufferArmed) {
    await stopEncoder()
    await ring.prune(0)
    ring = null
  }
  await publish()
}

/*
 * A cut point is only usable once the segment covering it has been written out,
 * so hold until index.csv catches up with it.
 */
async function waitForSegment(target: number): Promise<void> {
  if (!ring) return
  const deadline = Date.now() + (SEGMENT_SEC * 2 + 5) * 1000
  await ring.poll()
  while (ring.newestEnd < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await ring.poll()
  }
}

async function saveReplay(): Promise<void> {
  if (!bufferArmed || !ring || !settings || state === 'idle') {
    toast('warning', 'Geçmiş kayıt açık değil.')
    return
  }
  if (state === 'assembling') {
    toast('info', 'Önceki klip hazırlanıyor.')
    return
  }

  await ring.poll()
  if (ring.newestEnd <= 0) {
    toast('info', 'Tampon henüz doluyor — birkaç saniye bekle.')
    return
  }

  const postRoll = Math.max(0, settings.replay.postRollSec)
  if (postRoll > 0) await waitForSegment(ring.liveEnd + postRoll)

  const to = ring.newestEnd
  const from = to - settings.replay.durationSec
  await buildClip(from, to, 'Klip')
}

async function buildClip(from: number, to: number, label: string): Promise<void> {
  if (!ring || !settings || !encoder) return
  const previous = state
  /*
   * Where the recorded stretch ends on the wall clock. Taken now rather than
   * when the file lands, because joining the segments takes seconds and anyone
   * lining something else up against the clip would be that much off.
   */
  const endedAt = Date.now()
  state = 'assembling'
  await publish()

  try {
    const result = await assemble(ring, {
      from,
      to,
      outDir,
      name: fileName(label),
      mux: muxPath,
      workDir: join(ringDir, 'work')
    })

    const minutes = Math.floor(result.durationSec / 60)
    const seconds = Math.round(result.durationSec % 60)
    const length = `${minutes}:${String(seconds).padStart(2, '0')}`

    if (result.trimmedReason === 'buffer-filling') {
      toast('info', `${length} kaydedildi — tampon henüz doluyordu.`)
    } else if (result.trimmedReason === 'settings-changed') {
      toast('info', `${length} kaydedildi — tampon sırasında ekran ayarları değişti.`)
    } else {
      toast('success', `${length} kaydedildi.`)
    }
    if (result.note) log(result.note, 'info')
    log(`clip written: ${result.path}`, 'success')
    send({ type: 'clip', path: result.path, durationSec: result.durationSec, endedAt })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`Klip oluşturulamadı: ${detail}`)
  } finally {
    state = previous === 'assembling' ? 'armed' : previous
    await publish()
  }
}

function fileName(label: string): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`

  const template = settings?.output.filenameTemplate?.trim() || '{app} {date} - {time}'
  const name = template
    .replace(/\{app\}/g, label)
    .replace(/\{game\}/g, label)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)

  return name.replace(/[<>:"/\|?*]/g, '-').replace(/\s+/g, ' ').trim() || `${label} ${date}`
}

/*
 * Messages are handled strictly one at a time.
 *
 * Without this, `arm` could start running while `init` was still going, and
 * init's orphan sweep would then delete the segments and index.csv that the
 * encoder it raced with had just started writing. The buffer stayed silently
 * empty and 30MB of live files went missing on every launch.
 */
let queue: Promise<void> = Promise.resolve()

port?.on('message', (event) => {
  const message = event.data as Incoming
  queue = queue
    .then(() => handle(message))
    .catch((error: unknown) => fail(String(error)))
})

async function handle(message: Incoming): Promise<void> {
  switch (message.type) {
    case 'init':
      capturePath = message.capture
      muxPath = message.mux
      ringDir = message.ringDir
      outDir = message.outDir
      audioPipe = message.audioPipe
      settings = message.settings
      outputIdx = message.outputIdx

      await mkdir(ringDir, { recursive: true })
      const swept = await sweepOrphans(ringDir)
      if (swept.files > 0) {
        log(
          `cleared ${swept.files} orphaned file(s), ` +
            `${(swept.bytes / 1024 ** 2).toFixed(1)}MB reclaimed`,
          'warning'
        )
      }

      setInterval(() => void tick().catch(() => undefined), 1000)
      log('supervisor ready')
      await publish()
      break

    case 'settings': {
      const previous = settings
      settings = message.settings
      if (message.outDir) outDir = message.outDir

      // Moving the buffer elsewhere leaves the old folder full of segments that
      // nothing would ever clean, so sweep it on the way out.
      if (message.ringDir && message.ringDir !== ringDir) {
        const previous = ringDir
        const wasArmed = state !== 'idle'
        if (wasArmed) await setArmed(false)
        const swept = await sweepOrphans(previous)
        if (swept.files > 0) {
          log(`moved buffer, cleared ${swept.files} file(s) from ${previous}`, 'warning')
        }
        ringDir = message.ringDir
        await mkdir(ringDir, { recursive: true })
        if (wasArmed) await setArmed(true)
      }

      if (message.outputIdx !== undefined && message.outputIdx !== outputIdx) {
        outputIdx = message.outputIdx
        encoder = null
        if (state !== 'idle') {
          log(`display changed, restarting encoder on output ${outputIdx}`, 'warning')
          await stopEncoder()
          if (await ensureEncoder()) await startEncoder()
        }
      }

      const capture = settings.capture
      const before = previous?.capture
      if (before && before.codec !== capture.codec) encoder = null

      const qualityChanged =
        !!before &&
        (before.codec !== capture.codec ||
          before.fps !== capture.fps ||
          before.preset !== capture.preset ||
          before.bitrateKbps !== capture.bitrateKbps)

      if (qualityChanged && state !== 'idle') {
        log('quality changed, restarting encoder', 'warning')
        await stopEncoder()
        if (await ensureEncoder()) await startEncoder()
      }

      await publish()
      break
    }

    case 'arm':
      await setArmed(message.enabled)
      break

    case 'record':
      if (message.start) await startRecording()
      else await stopRecording()
      break

    case 'save-replay':
      await saveReplay()
      break

    case 'shutdown':
      state = 'idle'
      bufferArmed = false
      await stopEncoder()
      break
  }
}
