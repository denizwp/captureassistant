/**
 * The single object the supervisor pushes to main, and main forwards to any
 * visible renderer. Pushed on change only — nothing in this app polls.
 */

export type CaptureState = 'idle' | 'armed' | 'recording' | 'assembling'

export interface EncoderInfo {
  /** ffmpeg encoder name, e.g. "h264_nvenc". */
  id: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'software'
  hardware: boolean
}

export interface RingStats {
  segmentCount: number
  /** Seconds of footage currently retained. */
  bufferedSec: number
  bytesOnDisk: number
  /** Sustained write rate, for the SSD-wear readout. */
  bytesPerSec: number
  freeDiskBytes: number
}

export interface SupervisorState {
  state: CaptureState
  /** Seconds since the manual recording started; 0 when not recording. */
  recordingElapsedSec: number
  micActive: boolean
  encoder: EncoderInfo | null
  ring: RingStats | null
  /** Set when the pipeline is down and we are waiting to respawn. */
  lastError: string | null
}

export const INITIAL_STATE: SupervisorState = {
  state: 'idle',
  recordingElapsedSec: 0,
  micActive: false,
  encoder: null,
  ring: null,
  lastError: null
}

export interface Clip {
  id: string
  path: string
  name: string
  durationSec: number
  sizeBytes: number
  createdAt: number
  thumbnailPath: string | null
}
