import type { CaptureSettings, CodecId, QualityPreset } from '@shared/settings'

/**
 * FFmpeg argument construction for the ring encoder and the clip assembler.
 *
 * Everything here was verified end to end on Windows 11 (build 26200) with an
 * RTX 3060 and FFmpeg N-126335 before being written down. The notes marked
 * VERIFIED / REJECTED record what actually happened, because two of the three
 * filter chains that the documentation suggests do not work on this hardware.
 */

/* ── What the capture chain must not be ─────────────────────────────────
 *
 * REJECTED  ddagrab,scale_d3d11=format=nv12
 *   "Could not create the texture (80070057)" — E_INVALIDARG from
 *   AVHWFramesContext, then "Failed to configure output pad". The filter is
 *   compiled in and listed by `-filters`; it just cannot allocate an NV12
 *   D3D11 texture on this driver.
 *
 * REJECTED  ddagrab,hwmap=derive_device=cuda,scale_cuda=format=nv12
 *   "Failed to created derived device context: -40" (ENOSYS). No D3D11->CUDA
 *   interop in this build.
 *
 * VERIFIED  ddagrab -> h264_nvenc directly
 *   NVENC accepts AV_PIX_FMT_D3D11 and does the BGRA->NV12 conversion itself.
 *   No `hwdownload` anywhere, so frames never touch system memory. Output was
 *   1920x1080 yuv420p High, 300 frames in exactly 5.000s at 60fps.
 *
 * Keep the probe in `encoders.ts` honest about this: prefer the plain chain,
 * and only reach for a scaler when the user asks for a resolution scale.
 */

export interface EncoderChoice {
  /** ffmpeg encoder name, e.g. "h264_nvenc". */
  id: string
  hardware: boolean
}

/** Worst-case ceilings, also what the ring is sized against in the UI. */
export const PRESET_MAXRATE_KBPS: Record<QualityPreset, number> = {
  low: 20_000,
  balanced: 50_000,
  high: 90_000
}

const CQ: Record<CodecId, number> = { h264: 21, hevc: 23, av1: 24 }

/** Seconds per ring segment. Also the forced-IDR interval, so the two stay
 *  aligned — a segment that does not begin on an IDR is not independently
 *  decodable and silently corrupts the ring. */
export const SEGMENT_SEC = 2

export interface RingArgsInput {
  capture: CaptureSettings
  encoder: EncoderChoice
  /** DXGI output index, already resolved from the monitor the user picked. */
  outputIdx: number
  ringDir: string
  /** Continues numbering across a respawn so the janitor's index stays sane. */
  startNumber: number
  drawMouse: boolean
}

export function buildRingArgs(input: RingArgsInput): string[] {
  const { capture, encoder, outputIdx, ringDir, startNumber, drawMouse } = input
  const maxrateKbps =
    capture.bitrateKbps > 0 ? capture.bitrateKbps : PRESET_MAXRATE_KBPS[capture.preset]

  const source =
    `ddagrab=output_idx=${outputIdx}` +
    `:framerate=${capture.fps}` +
    `:draw_mouse=${drawMouse ? 1 : 0}` +
    // Repeats the last frame when the desktop is static. This is what makes
    // the output CFR, which A/V sync depends on. Never disable it.
    `:dup_frames=1` +
    `:output_fmt=bgra` +
    // Without this, asking for a format the desktop is not in is a hard error
    // rather than a fallback.
    `:allow_fallback=1`

  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'level+warning',
    '-progress', 'pipe:1',

    // Pin the D3D11 device to the adapter driving the chosen output. DDA fails
    // or returns black when the capturing process is on a different adapter.
    '-init_hw_device', `d3d11va=dda:${outputIdx}`,
    '-filter_hw_device', 'dda',
    '-filter_complex', `${source}[v]`,
    '-map', '[v]',

    ...encoderArgs(encoder, capture, maxrateKbps),

    '-fps_mode', 'cfr',
    '-max_muxing_queue_size', '2048',
    '-muxdelay', '0',
    '-muxpreload', '0',

    ...segmentArgs(ringDir, startNumber)
  ]
}

function encoderArgs(
  encoder: EncoderChoice,
  capture: CaptureSettings,
  maxrateKbps: number
): string[] {
  const gop = String(capture.fps * SEGMENT_SEC)
  const maxrate = `${maxrateKbps}k`
  const bufsize = `${maxrateKbps * 2}k`

  const rateControl = [
    // Capped CQ: constant perceptual quality with a hard ceiling. Pure CBR
    // wastes bitrate on static menus; pure CQ makes the ring's disk footprint
    // unpredictable, and we promise the user a size up front.
    '-rc', 'vbr',
    '-cq', String(CQ[capture.codec]),
    '-b:v', '0',
    '-maxrate', maxrate,
    '-bufsize', bufsize
  ]

  const keyframes = [
    '-g', gop,
    // `-force_key_frames` alone emits a plain I-frame. Without `-forced-idr`
    // references cross the segment boundary and chunks stop being independently
    // decodable — the single most important flag in this file.
    '-forced-idr', '1',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`
  ]

  if (encoder.id.endsWith('_nvenc')) {
    return [
      '-c:v', encoder.id,
      // `-tune ll`/`ull` exist for sub-frame latency in cloud gaming; they drop
      // B-frames and lookahead for a budget we do not need. Ours is 2 seconds.
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

  // Software fallback. The UI caps the user at 1080p30 when we land here and
  // says plainly that it will cost frames.
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
    // Almost every tutorial says to set this to 1. Do not. With 1 each segment
    // restarts at PTS 0 and a byte-concat produces 0->2, 0->2, 0->2 garbage.
    // With 0 the PTS is continuous across the whole ring and concat is correct.
    '-reset_timestamps', '0',
    '-segment_start_number', String(startNumber),
    // One `file,start,end` line per closed segment. Tailing this gives exact
    // durations without ffprobe-ing hundreds of files.
    '-segment_list', `${ringDir}\\index.csv`,
    '-segment_list_type', 'csv',
    '-segment_list_size', '0',
    '-segment_list_flags', '+live',
    // Deliberately NOT `-segment_wrap`: it recycles filenames and can overwrite
    // a segment an in-flight assembly job is still reading.
    `${ringDir}\\seg_%06d.ts`
  ]
}

/* ── Assembling a clip ──────────────────────────────────────────────────
 *
 * VERIFIED  a middle segment decodes standalone: 120 frames, no errors, first
 *   frame key_frame=1. Byte-concatenating two segments gives 240 frames with a
 *   maximum inter-frame gap of exactly 1/60s — the ring joins frame-perfectly.
 *
 * VERIFIED  head re-encode needs OUTPUT-side seeking. `-ss` before `-i`
 *   produces a zero-byte file, with or without `-copyts`, because the segment's
 *   own timeline starts at its absolute ring offset rather than zero. Putting
 *   `-ss` after `-i` decodes and discards, which costs nothing over 2 seconds.
 *
 * VERIFIED  `-copyts` does NOT preserve the absolute timestamp through an
 *   output-side seek; the head comes back rebased near zero. `-output_ts_offset
 *   <t_start>` puts it back on the ring's timeline, and the head then butts
 *   exactly against the following segment.
 *
 * KNOWN     `-t <D>` on the copy pass truncates mid-GOP and can leave the final
 *   one or two frames ragged. At the end of a replay clip this is imperceptible;
 *   revisit only if it shows up in practice.
 */

export function buildHeadArgs(opts: {
  segmentPath: string
  /** Absolute ring timestamp the clip should begin at. */
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
    // After -i on purpose: see the note above.
    '-ss', startTime.toFixed(6),
    '-map', '0',
    ...encoderArgs(encoder, capture, maxrateKbps),
    '-output_ts_offset', startTime.toFixed(6),
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    '-y',
    outPath
  ]
}

/** Reads the concatenated head + tail segments from stdin. The supervisor pipes
 *  their raw bytes in order: MPEG-TS repeats its parameter sets in-band, so a
 *  byte concat is valid and sidesteps both the concat demuxer's codec-equality
 *  check and Windows' 32k command line limit. */
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
    // Not `+faststart`: it costs a full second pass over a multi-gigabyte file
    // for a benefit local playback and Discord upload do not need.
    '-y',
    opts.outPath
  ]
}
