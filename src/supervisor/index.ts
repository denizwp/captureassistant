/**
 * Capture supervisor — runs as an Electron utilityProcess.
 *
 * Owns the ffmpeg ring encoder, the segment index, the janitor, the disk guard
 * and the clip assembler. It lives out of the main process so a leak or crash
 * in the segment or assembly logic cannot take down the tray, the hotkeys, or
 * the sibling processes of an in-flight recording.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import type { CaptureState, SupervisorState } from '@shared/state'
import { assemble } from './assembler'
import { probeCapture, probeEncoder } from './encoders'
import { buildRingArgs, PRESET_MAXRATE_KBPS, SEGMENT_SEC, type EncoderChoice } from './pipeline'
import { Ring } from './ring'

interface InitMessage {
  type: 'init'
  ffmpeg: string
  ringDir: string
  outDir: string
  audioPipe: string
  settings: Settings
}

type Incoming =
  | InitMessage
  | { type: 'settings'; settings: Settings }
  | { type: 'arm'; enabled: boolean }
  | { type: 'record'; start: boolean }
  | { type: 'save-replay' }
  | { type: 'shutdown' }

/** How long the disk guard insists on keeping free beyond the ring itself. */
const DISK_HEADROOM_BYTES = 5 * 1024 ** 3

let settings: Settings | null = null
let ffmpegPath = ''
let ringDir = ''
let outDir = ''
let audioPipe = ''
let ring: Ring | null = null
let encoder: EncoderChoice | null = null

let child: ChildProcess | null = null
let restarting = false
let stopping = false
let consecutiveFailures = 0
let startedAt = 0

/** A process that dies faster than this never really ran; anything longer is
 *  treated as a healthy run that hit an access-lost, which is routine. */
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
  return 'software'
}

/* ── ffmpeg lifecycle ───────────────────────────────────────────────── */

/**
 * Starts the ring encoder.
 *
 * `vsrc_ddagrab.c` does not handle `DXGI_ERROR_ACCESS_LOST`, and access-lost is
 * raised on fullscreen transitions, resolution changes, driver resets and the
 * UAC secure desktop — every one of which is routine while gaming. So ffmpeg
 * dying is not an error path here, it is the normal flow: respawn, continue
 * segment numbering, and record a new run so the assembler knows the two sides
 * may not be byte-concatenable.
 */
async function startEncoder(): Promise<void> {
  if (child || !settings || !ring || !encoder) return

  await mkdir(ringDir, { recursive: true })

  const args = buildRingArgs({
    capture: settings.capture,
    encoder,
    outputIdx: 0,
    ringDir,
    startNumber: ring.nextSegmentNumber,
    drawMouse: true,
    // The pipe always carries four channels; a disabled source is silence, not
    // a missing channel, so the graph stays identical either way.
    audioPipe:
      settings.audio.systemEnabled || settings.audio.micEnabled ? audioPipe : null,
    separateTracks: settings.audio.separateTracks && settings.audio.micEnabled
  })

  ring.beginRun({
    width: 0,
    height: 0,
    fps: settings.capture.fps,
    codec: encoder.id
  })

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  startedAt = Date.now()
  log(`encoder started (${encoder.id})`, 'success')

  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderr = `${stderr}${text}`.slice(-2000)
    for (const line of text.split('\n')) {
      if (line.trim()) log(`ffmpeg: ${line.trim()}`, 'warning')
    }
  })

  proc.on('close', (code) => {
    child = null
    if (stopping || state === 'idle') return

    // A long-lived process that died is almost always DXGI access-lost — a
    // fullscreen switch or a resolution change — and respawning is the normal
    // flow. A process that dies immediately is a configuration error, and
    // respawning it forever would just burn CPU while saying nothing useful.
    const lived = Date.now() - startedAt
    consecutiveFailures = lived < HEALTHY_RUN_MS ? consecutiveFailures + 1 : 0

    if (consecutiveFailures > MAX_FAST_FAILURES) {
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1) ?? `çıkış kodu ${code}`
      state = 'idle'
      fail(`Kayıt motoru başlatılamıyor: ${detail.slice(0, 200)}`)
      return
    }

    log(`encoder exited (${code}) after ${(lived / 1000).toFixed(1)}s — restarting`, 'warning')
    if (restarting) return
    restarting = true
    // Back off as failures repeat so a broken setup does not spin.
    const delay = Math.min(400 * 2 ** consecutiveFailures, 5000)
    setTimeout(() => {
      restarting = false
      void startEncoder().catch((error: unknown) => fail(String(error)))
    }, delay)
  })
}

/**
 * Stops the encoder and waits for the process to actually be gone.
 *
 * Windows refuses to unlink a file a live process still has open, so returning
 * before ffmpeg has exited leaves `index.csv` locked and the next arm fails
 * with EBUSY. Killing is not the same as having exited.
 */
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
      // SIGTERM lets ffmpeg finish the segment it is writing; if it hangs on
      // that, take it down hard rather than blocking the UI.
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

function fail(message: string): void {
  lastError = message
  log(message, 'error')
  toast('error', message)
  void publish()
}

/* ── ticks ──────────────────────────────────────────────────────────── */

/** One second is fast enough for a two-second segment and slow enough that the
 *  supervisor stays invisible in a profile. */
async function tick(): Promise<void> {
  if (!ring || !settings || state === 'idle') return

  await ring.poll()
  await ring.measure()

  // While a manual recording is running its span is pinned, so the janitor
  // trims only what is outside both the replay window and the recording.
  const keep = settings.replay.enabled
    ? settings.replay.durationSec + settings.replay.postRollSec
    : SEGMENT_SEC * 4
  await ring.prune(keep)

  await diskGuard()
  await publish()
}

/**
 * Never let a recorder fill someone's system drive.
 *
 * The threshold is the worst-case ring plus headroom rather than the observed
 * size, because the observed size is low while the scene is static and can double
 * the moment something bright and fast happens.
 */
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
    log('disk guard tripped, disarming', 'error')
    await setArmed(false)
  }
}

/* ── commands ───────────────────────────────────────────────────────── */

async function ensureEncoder(): Promise<boolean> {
  if (encoder || !settings) return !!encoder

  log('probing encoders…')
  const captureError = await probeCapture(ffmpegPath, 0)
  if (captureError) {
    fail(`Ekran yakalanamadı: ${captureError}`)
    return false
  }

  const result = await probeEncoder(ffmpegPath, settings.capture.codec)
  for (const item of result.rejected) log(`${item.id}: ${item.reason}`, 'warning')
  encoder = result.encoder
  log(`using ${encoder.id}`, 'success')
  if (!encoder.hardware) {
    toast('warning', 'Donanım encoder bulunamadı — yazılım encode oyunu yavaşlatır.')
  }
  return true
}

async function setArmed(enabled: boolean): Promise<void> {
  if (!settings) return

  if (enabled) {
    if (state !== 'idle') return
    if (!(await ensureEncoder())) return
    ring = new Ring(ringDir)
    await mkdir(ringDir, { recursive: true })
    await ring.reset()
    state = 'armed'
    lastError = null
    consecutiveFailures = 0
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

  // Recording shares the encoder with the buffer: if it is already running,
  // this only marks a point on the timeline. Nothing extra is encoded.
  if (state === 'idle') {
    if (!(await ensureEncoder())) return
    ring = new Ring(ringDir)
    await mkdir(ringDir, { recursive: true })
    await ring.reset()
    await startEncoder()
    // Give the muxer a moment to close its first segment.
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  recordStart = ring?.newestEnd ?? 0
  recordStartedAt = Date.now()
  ring?.pin(ring.nextSegmentNumber, null, 'recording')
  state = 'recording'
  log('recording started', 'success')
  await publish()
}

async function stopRecording(): Promise<void> {
  if (state !== 'recording' || !ring || !settings || !encoder) return
  const from = recordStart ?? 0
  recordStart = null
  state = settings.replay.enabled ? 'armed' : 'idle'
  await publish()

  await ring.poll()
  const to = ring.newestEnd
  ring.unpin('recording')

  await buildClip(from, to, 'Kayıt')

  if (!settings.replay.enabled) {
    await stopEncoder()
    await ring.prune(0)
    ring = null
  }
  await publish()
}

async function saveReplay(): Promise<void> {
  if (!ring || !settings || state === 'idle') {
    toast('warning', 'Geçmiş kayıt açık değil.')
    return
  }
  if (state === 'assembling') {
    toast('info', 'Önceki klip hazırlanıyor.')
    return
  }

  // Segments only land on disk when the muxer closes them, so there is a short
  // window after arming where the buffer genuinely holds nothing. That is
  // normal, not a failure — say so plainly instead of throwing.
  await ring.poll()
  const to = ring.newestEnd
  if (to <= 0) {
    toast('info', 'Tampon henüz doluyor — birkaç saniye bekle.')
    return
  }

  const from = to - settings.replay.durationSec
  await buildClip(from, to, 'Klip')
}

async function buildClip(from: number, to: number, label: string): Promise<void> {
  if (!ring || !settings || !encoder) return
  const previous = state
  state = 'assembling'
  await publish()

  try {
    const result = await assemble(ring, {
      from,
      to,
      outDir,
      name: fileName(label),
      encoder,
      capture: settings.capture,
      ffmpeg: ffmpegPath,
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
    log(`clip written: ${result.path}`, 'success')
    send({ type: 'clip', path: result.path, durationSec: result.durationSec })
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
  return `${label} ${date} - ${time}`
}

/* ── wiring ─────────────────────────────────────────────────────────── */

port?.on('message', (event) => {
  const message = event.data as Incoming
  void handle(message).catch((error: unknown) => fail(String(error)))
})

async function handle(message: Incoming): Promise<void> {
  switch (message.type) {
    case 'init':
      ffmpegPath = message.ffmpeg
      ringDir = message.ringDir
      outDir = message.outDir
      audioPipe = message.audioPipe
      settings = message.settings
      setInterval(() => void tick().catch(() => undefined), 1000)
      log('supervisor ready')
      await publish()
      break

    case 'settings': {
      const previous = settings
      settings = message.settings
      // Changing the codec invalidates the probed encoder.
      if (previous && previous.capture.codec !== settings.capture.codec) encoder = null
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
      await stopEncoder()
      break
  }
}
