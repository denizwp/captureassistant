import type { CaptureSettings, CodecId, QualityPreset } from '@shared/settings'

/*
 * Verified on Windows 11 26200 / RTX 3060 / FFmpeg N-126335. Two of the three
 * documented capture chains do not work there:
 *
 *   ddagrab,scale_d3d11=format=nv12       -> "Could not create the texture
 *                                            (80070057)". The filter is there,
 *                                            it just cannot allocate NV12.
 *   ddagrab,hwmap=derive_device=cuda,...  -> "Failed to created derived device
 *                                            context: -40" (ENOSYS).
 *   ddagrab -> h264_nvenc directly        -> works, and stays on the GPU.
 */

export interface EncoderChoice {
  id: string
  hardware: boolean
}

export const PRESET_MAXRATE_KBPS: Record<QualityPreset, number> = {
  low: 20_000,
  balanced: 50_000,
  high: 90_000
}

const CQ: Record<CodecId, number> = { h264: 21, hevc: 23, av1: 24 }

export const SEGMENT_SEC = 2

export interface RingArgsInput {
  capture: CaptureSettings
  encoder: EncoderChoice
  outputIdx: number
  adapterIdx: number
  ringDir: string
  startNumber: number
  drawMouse: boolean

  audioPipe: string | null

  /*
   * Drops the encoder settings that run on the GPU's shaders rather than on the
   * encode block. They cost little on a card with room to spare, but on a busy
   * one they queue behind the game and hold the capture back with them.
   */
  lowOverhead?: boolean
}

export function buildRingArgs(input: RingArgsInput): string[] {
  const { capture, encoder, outputIdx, adapterIdx, ringDir, startNumber, drawMouse, audioPipe } =
    input
  const maxrateKbps =
    capture.bitrateKbps > 0 ? capture.bitrateKbps : PRESET_MAXRATE_KBPS[capture.preset]

  const source =
    `ddagrab=output_idx=${outputIdx}` +
    `:framerate=${capture.fps}` +
    `:draw_mouse=${drawMouse ? 1 : 0}` +

    `:dup_frames=1` +
    `:output_fmt=bgra` +
    `:allow_fallback=1`

  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'level+warning',
    '-progress', 'pipe:1',

    '-init_hw_device', `d3d11va=dda:${adapterIdx}`,
    '-filter_hw_device', 'dda',

    ...(audioPipe
      ? [
          '-thread_queue_size', '512',
          '-f', 'f32le',
          '-ar', '48000',
          '-ac', '4',
          '-channel_layout', 'quad',
          '-i', audioPipe
        ]
      : []),

    '-filter_complex',
    audioPipe ? `${source}[v];${audioGraph()}` : `${source}[v]`,
    ...audioMaps(input),

    ...encoderArgs(encoder, capture, maxrateKbps, input.lowOverhead ?? false),
    ...(audioPipe ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),

    '-fps_mode', 'cfr',
    '-max_muxing_queue_size', '2048',
    '-muxdelay', '0',
    '-muxpreload', '0',

    ...segmentArgs(ringDir, startNumber)
  ]
}

function audioGraph(): string {
  return [
    '[0:a]channelsplit=channel_layout=quad[sl][sr][ml][mr]',
    '[sl][sr]join=inputs=2:channel_layout=stereo[sys]',
    '[ml][mr]join=inputs=2:channel_layout=stereo[mic]',
    // normalize=0 matters: the default divides by the input count, so turning
    // the microphone on would quietly halve the game.
    '[sys][mic]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97[amix]'
  ].join(';')
}

function audioMaps(input: RingArgsInput): string[] {
  if (!input.audioPipe) return ['-map', '[v]']
  return ['-map', '[v]', '-map', '[amix]']
}

function encoderArgs(
  encoder: EncoderChoice,
  capture: CaptureSettings,
  maxrateKbps: number,
  lowOverhead = false
): string[] {
  const gop = String(capture.fps * SEGMENT_SEC)
  const maxrate = `${maxrateKbps}k`
  const bufsize = `${maxrateKbps * 2}k`

  const rateControl = [
    '-rc', 'vbr',
    '-cq', String(CQ[capture.codec]),
    '-b:v', '0',
    '-maxrate', maxrate,
    '-bufsize', bufsize
  ]

  const keyframes = [
    '-g', gop,

    // Without this the forced frames are plain I-frames, references cross
    // segment boundaries, and the ring silently stops being splittable.
    '-forced-idr', '1',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`
  ]

  if (encoder.id.endsWith('_nvenc')) {
    if (lowOverhead) {
      return [
        '-c:v', encoder.id,
        '-preset', 'p4',
        '-tune', 'll',
        ...(capture.codec === 'h264' ? ['-profile:v', 'high'] : []),
        ...rateControl,
        '-bf', '0',
        '-rc-lookahead', '0',
        '-spatial-aq', '0',
        ...keyframes
      ]
    }
    return [
      '-c:v', encoder.id,

      '-preset', 'p5',
      '-tune', 'hq',
      ...(capture.codec === 'h264' ? ['-profile:v', 'high'] : []),
      ...rateControl,
      '-bf', '2',
      '-b_ref_mode', 'middle',
      '-rc-lookahead', '20',
      '-spatial-aq', '1',
      '-aq-strength', '8',
      ...keyframes
    ]
  }

  if (encoder.id.endsWith('_amf')) {
    return [
      '-c:v', encoder.id,
      '-usage', 'transcoding',
      '-quality', 'quality',
      '-rc', 'vbr_peak',
      '-b:v', maxrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-vbaq', 'true',
      '-preencode', 'true',
      '-bf', '2',
      '-g', gop,
      '-forced_idr', '1',
      '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`
    ]
  }

  if (encoder.id.endsWith('_qsv')) {
    return [
      '-c:v', encoder.id,
      '-preset', 'veryfast',
      '-global_quality', String(CQ[capture.codec] + 1),
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-async_depth', '4',
      '-low_power', '1',
      ...keyframes
    ]
  }

  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-g', gop,
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`
  ]
}

function segmentArgs(ringDir: string, startNumber: number): string[] {
  return [
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SEC),
    '-segment_format', 'mpegts',

    // Most guides say 1. Don't: every segment would restart at PTS 0 and a byte
    // concat would come out as 0->2, 0->2, 0->2.
    '-reset_timestamps', '0',
    '-segment_start_number', String(startNumber),

    '-segment_list', `${ringDir}\\index.csv`,
    '-segment_list_type', 'csv',
    '-segment_list_size', '0',
    '-segment_list_flags', '+live',

    `${ringDir}\\seg_%06d.ts`
  ]
}

export function buildHeadArgs(opts: {
  segmentPath: string

  startTime: number
  encoder: EncoderChoice
  capture: CaptureSettings
  outPath: string
}): string[] {
  const { segmentPath, startTime, encoder, capture, outPath } = opts
  const maxrateKbps =
    capture.bitrateKbps > 0 ? capture.bitrateKbps : PRESET_MAXRATE_KBPS[capture.preset]

  return [
    '-hide_banner',
    '-v', 'error',
    '-copyts',
    '-i', segmentPath,
    '-ss', startTime.toFixed(6),
    '-map', '0',
    ...encoderArgs(encoder, capture, maxrateKbps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-output_ts_offset', startTime.toFixed(6),
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    '-y',
    outPath
  ]
}

export function buildAssembleArgs(opts: { durationSec: number; outPath: string }): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-progress', 'pipe:1',
    '-fflags', '+genpts',
    '-f', 'mpegts',
    '-i', 'pipe:0',
    '-map', '0',
    '-c', 'copy',
    '-t', opts.durationSec.toFixed(3),
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',

    '-y',
    opts.outPath
  ]
}
