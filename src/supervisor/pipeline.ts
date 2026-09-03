import type { QualityPreset } from '@shared/settings'

export interface EncoderChoice {
  id: string
  hardware: boolean
}

export const PRESET_MAXRATE_KBPS: Record<QualityPreset, number> = {
  low: 20_000,
  balanced: 50_000,
  high: 90_000
}

export const SEGMENT_SEC = 2
