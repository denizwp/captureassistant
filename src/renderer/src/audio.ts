/**
 * Audio pump.
 *
 * FFmpeg has no WASAPI loopback input device on Windows, and the DirectShow
 * virtual-device route needs a driver install we do not want to inflict on
 * users. Chromium can do loopback capture, but only from a renderer — hence
 * this hidden page.
 *
 * Both sources feed one AudioContext and one worklet, so system audio and mic
 * are sampled off the same clock and cannot drift apart from each other by
 * construction. The four channels leave as one interleaved f32le stream and
 * are split again inside the ffmpeg filter graph.
 */

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
      status(payload: {
        running: boolean
        error?: string
        devices?: MicDevice[]
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

/**
 * Electron's main process turns this into WASAPI loopback.
 *
 * Audio-only is the path worth having — it skips `desktopCapturer` and never
 * starts a screen capture. The spec says `video: false` is invalid for
 * getDisplayMedia and some Chromium versions enforce that, so fall back to
 * asking for video and discarding the track.
 */
async function captureLoopback(): Promise<MediaStream> {
  // Chromium's capture pipeline downmixes to mono whenever the voice
  // processing chain is engaged, so every one of these has to be off before it
  // will hand back a stereo pair — which a game recorder needs.
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

/**
 * A gain stage pinned to two channels.
 *
 * `channelCountMode: 'explicit'` with speaker interpretation makes Web Audio
 * up-mix a mono source to stereo and down-mix a 5.1 one with the proper ITU
 * coefficients, so whatever the endpoint's mix format happens to be, what
 * leaves here is always a real stereo pair.
 */
function stereoGain(ctx: AudioContext, value: number): GainNode {
  const gain = ctx.createGain()
  gain.channelCount = 2
  gain.channelCountMode = 'explicit'
  gain.channelInterpretation = 'speakers'
  gain.gain.value = value
  return gain
}

/** Splits a stereo node into its two channels and lands them on consecutive
 *  merger inputs. Connecting the node itself twice would copy channel 0 to
 *  both and quietly collapse the source to mono. */
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
let systemStream: MediaStream | null = null
let micStream: MediaStream | null = null
let systemGain: GainNode | null = null
let micGain: GainNode | null = null

async function start(config: AudioConfig): Promise<void> {
  await stop()

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' })
  context = ctx

  // `new URL(..., import.meta.url)` is the one form Vite rewrites correctly for
  // both the dev server and a file:// production build.
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href)

  // Four discrete channels: system L/R then mic L/R.
  const merger = ctx.createChannelMerger(4)

  if (config.systemEnabled) {
    systemStream = await captureLoopback()
    // Nothing here wants pixels; if a video track came back, drop it at once.
    for (const track of systemStream.getVideoTracks()) track.stop()

    const source = ctx.createMediaStreamSource(systemStream)
    systemGain = stereoGain(ctx, config.systemGain)
    source.connect(systemGain)
    splitToMerger(ctx, systemGain, merger, 0)
  }

  if (config.micEnabled) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(config.micDeviceId ? { deviceId: { exact: config.micDeviceId } } : {}),
        // We are recording, not making a call — leave the signal alone.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    const source = ctx.createMediaStreamSource(micStream)
    micGain = stereoGain(ctx, config.micGain)
    source.connect(micGain)
    splitToMerger(ctx, micGain, merger, 2)
  }

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

  // A node with nothing downstream of the destination is never pulled, so the
  // worklet would simply not run. Route it through a silent gain instead of
  // playing the capture back into the room.
  const sink = ctx.createGain()
  sink.gain.value = 0
  pump.connect(sink)
  sink.connect(ctx.destination)

  await ctx.resume()
  window.audioBridge.status({
    running: true,
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

  if (context) {
    await context.close()
    context = null
  }
}

/** Applied live — toggling the mic mid-recording must not restart ffmpeg, or
 *  the ring breaks. The track keeps running and simply goes silent. */
function setGains(config: Pick<AudioConfig, 'systemGain' | 'micGain'>): void {
  if (systemGain) systemGain.gain.value = config.systemGain
  if (micGain) micGain.gain.value = config.micGain
}

/** What the source actually handed us, as opposed to what we asked for. */
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
    | { type: 'devices' }

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
    case 'devices':
      void listMics().then((devices) => window.audioBridge.status({ running: !!context, devices }))
      break
  }
})

// Device changes (headset unplugged, default output switched) rebuild the
// graph rather than killing ffmpeg — the pipe keeps flowing.
navigator.mediaDevices.addEventListener('devicechange', () => {
  void listMics().then((devices) => window.audioBridge.status({ running: !!context, devices }))
})

window.audioBridge.ready()

export {}
