export type CaptureState = 'idle' | 'armed' | 'recording' | 'assembling'

export interface EncoderInfo {
  id: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'software'
  hardware: boolean
}

export interface RingStats {
  segmentCount: number

  bufferedSec: number
  bytesOnDisk: number

  bytesPerSec: number
  freeDiskBytes: number
}

export interface SupervisorState {
  state: CaptureState

  recordingElapsedSec: number
  micActive: boolean
  encoder: EncoderInfo | null
  ring: RingStats | null

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
