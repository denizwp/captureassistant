interface AudioConfig {
  systemEnabled: boolean
  micEnabled: boolean
  micDeviceId: string | null
  systemGain: number
  micGain: number
}

declare global {
  interface Window {
    audioBridge: {
      writePcm(buffer: ArrayBuffer): void
      ready(): void
      levels(payload: { system: number; mic: number }): void
      status(payload: {
        running: boolean
        error?: string
        devices?: MicDevice[]
        latencySec?: number
        diagnostics?: Record<string, unknown>
      }): void
      on(listener: (payload: unknown) => void): () => void
    }
  }
}

interface MicDevice {
  id: string
  label: string
}

const SAMPLE_RATE = 48_000
const BLOCK_FRAMES = 960

async function captureLoopback(): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ audio, video: false })
  } catch {
    return await navigator.mediaDevices.getDisplayMedia({ audio, video: true })
  }
}

/*
 * Samples reach ffmpeg later than the frames they belong to: the loopback device
 * buffers, the context buffers again, and the worklet only hands over whole
 * blocks. ffmpeg stamps them on arrival, so without telling it about this the
 * sound ends up sitting behind the picture.
 */
function captureLatency(ctx: AudioContext): number {
  const [track] = systemStream?.getAudioTracks() ?? []
  const settings = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
  const device = settings?.latency ?? 0
  return device + ctx.baseLatency + BLOCK_FRAMES / SAMPLE_RATE
}

function stereoGain(ctx: AudioContext, value: number): GainNode {
  const gain = ctx.createGain()
  gain.channelCount = 2
  gain.channelCountMode = 'explicit'
  gain.channelInterpretation = 'speakers'
  gain.gain.value = value
  return gain
}

function splitToMerger(
  ctx: AudioContext,
  node: AudioNode,
  merger: ChannelMergerNode,
  firstInput: number
): void {
  const splitter = ctx.createChannelSplitter(2)
  node.connect(splitter)
  splitter.connect(merger, 0, firstInput)
  splitter.connect(merger, 1, firstInput + 1)
}

let context: AudioContext | null = null
let merger: ChannelMergerNode | null = null
let systemStream: MediaStream | null = null
let micStream: MediaStream | null = null
let systemGain: GainNode | null = null
let micGain: GainNode | null = null
let systemMeter: AnalyserNode | null = null
let micMeter: AnalyserNode | null = null
let meterTimer: ReturnType<typeof setInterval> | null = null

const FLOOR_DB = -100
const meterFrame = new Float32Array(2048)

function meterFor(ctx: AudioContext, node: AudioNode): AnalyserNode {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = meterFrame.length
  node.connect(analyser)
  return analyser
}

function peakDb(analyser: AnalyserNode | null): number {
  if (!analyser) return FLOOR_DB
  analyser.getFloatTimeDomainData(meterFrame)
  let peak = 0
  for (const sample of meterFrame) {
    const value = Math.abs(sample)
    if (value > peak) peak = value
  }
  return peak > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(peak)) : FLOOR_DB
}

/*
 * Only runs while the settings window is up. This page lives for the whole
 * session, and a 10Hz timer here would tick through every game.
 */
function setMetering(enabled: boolean): void {
  if (meterTimer) {
    clearInterval(meterTimer)
    meterTimer = null
  }
  if (!enabled) return
  meterTimer = setInterval(() => {
    window.audioBridge.levels({ system: peakDb(systemMeter), mic: peakDb(micMeter) })
  }, 100)
}

async function start(config: AudioConfig): Promise<void> {
  await stop()

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' })
  context = ctx

  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href)

  merger = ctx.createChannelMerger(4)

  if (config.systemEnabled) {
    systemStream = await captureLoopback()

    for (const track of systemStream.getVideoTracks()) track.stop()

    const source = ctx.createMediaStreamSource(systemStream)
    systemGain = stereoGain(ctx, config.systemGain)
    source.connect(systemGain)
    systemMeter = meterFor(ctx, systemGain)
    splitToMerger(ctx, systemGain, merger, 0)
  }

  if (config.micEnabled) await attachMic(config.micDeviceId, config.micGain)

  const pump = new AudioWorkletNode(ctx, 'pcm-pump', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 4,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete'
  })
  pump.port.onmessage = (event: MessageEvent<Float32Array>) => {
    window.audioBridge.writePcm(event.data.buffer as ArrayBuffer)
  }
  merger.connect(pump)

  const sink = ctx.createGain()
  sink.gain.value = 0
  pump.connect(sink)
  sink.connect(ctx.destination)

  await ctx.resume()
  window.audioBridge.status({
    running: true,
    latencySec: captureLatency(ctx),
    devices: await listMics(),
    diagnostics: {
      contextRate: ctx.sampleRate,
      systemTrackChannels: describeTrack(systemStream),
      micTrackChannels: describeTrack(micStream)
    }
  })
}

async function stop(): Promise<void> {
  for (const stream of [systemStream, micStream]) {
    stream?.getTracks().forEach((track) => track.stop())
  }
  systemStream = null
  micStream = null
  systemGain = null
  micGain = null
  systemMeter = null
  micMeter = null
  merger = null
  setMetering(false)

  if (context) {
    await context.close()
    context = null
  }
}

let micDeviceId: string | null = null

async function attachMic(deviceId: string | null, gain: number): Promise<void> {
  const ctx = context
  if (!ctx || !merger) return
  // Swapping devices means tearing the old one down first, otherwise the
  // early return below would silently keep recording the previous microphone.
  if (micStream && deviceId !== micDeviceId) detachMic()
  if (micStream) {
    if (micGain) micGain.gain.value = gain
    return
  }
  micDeviceId = deviceId

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),

      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })

  const source = ctx.createMediaStreamSource(micStream)
  micGain = stereoGain(ctx, gain)
  source.connect(micGain)
  micMeter = meterFor(ctx, micGain)
  splitToMerger(ctx, micGain, merger, 2)
}

function detachMic(): void {
  micStream?.getTracks().forEach((track) => track.stop())
  micStream = null
  micGain?.disconnect()
  micGain = null
  micMeter = null
}

function setGains(config: Pick<AudioConfig, 'systemGain' | 'micGain'>): void {
  if (systemGain) systemGain.gain.value = config.systemGain
  if (micGain) micGain.gain.value = config.micGain
}

function describeTrack(stream: MediaStream | null): string {
  const [track] = stream?.getAudioTracks() ?? []
  if (!track) return 'none'
  const settings = track.getSettings() as MediaTrackSettings & { channelCount?: number }
  return `channels=${settings.channelCount ?? '?'} rate=${settings.sampleRate ?? '?'}`
}

async function listMics(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default')
    .map((device) => ({ id: device.deviceId, label: device.label || 'Mikrofon' }))
}

window.audioBridge.on((payload) => {
  const message = payload as
    | { type: 'start'; config: AudioConfig }
    | { type: 'stop' }
    | { type: 'gains'; config: Pick<AudioConfig, 'systemGain' | 'micGain'> }
    | { type: 'mic'; enabled: boolean; deviceId: string | null; gain: number }
    | { type: 'devices' }
    | { type: 'meter'; enabled: boolean }

  switch (message.type) {
    case 'start':
      start(message.config).catch((error: unknown) => {
        window.audioBridge.status({ running: false, error: String(error) })
      })
      break
    case 'stop':
      void stop().then(() => window.audioBridge.status({ running: false }))
      break
    case 'gains':
      setGains(message.config)
      break
    case 'meter':
      setMetering(message.enabled)
      break
    case 'mic':
      if (message.enabled) {
        attachMic(message.deviceId, message.gain).catch((error: unknown) => {
          window.audioBridge.status({ running: true, error: String(error) })
        })
      } else {
        detachMic()
      }
      break
    case 'devices':
      void listMics().then((devices) => window.audioBridge.status({ running: !!context, devices }))
      break
  }
})

navigator.mediaDevices.addEventListener('devicechange', () => {
  void listMics().then((devices) => window.audioBridge.status({ running: !!context, devices }))
})

window.audioBridge.ready()

export {}
