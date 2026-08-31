export type CodecId = 'h264' | 'hevc' | 'av1'
export type QualityPreset = 'low' | 'balanced' | 'high'
export type IndicatorCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface CaptureSettings {
  monitorId: string | null
  fps: number

  bitrateKbps: number
  codec: CodecId

  scale: number
  preset: QualityPreset
}

export interface ReplaySettings {
  enabled: boolean

  durationSec: number

  postRollSec: number

  bufferDir: string | null
}

export interface AudioSettings {
  systemEnabled: boolean
  systemGain: number
  micEnabled: boolean

  micDeviceId: string | null
  micGain: number

  separateTracks: boolean
}

export interface HotkeySettings {
  saveReplay: string
  toggleRecord: string
  toggleReplayBuffer: string
  toggleMic: string
  toggleIndicators: string
}

export interface OutputSettings {
  dir: string | null

  filenameTemplate: string
}

export interface AppSettings {
  minimizeToTray: boolean
  launchAtLogin: boolean
  theme: 'dark' | 'light'
  indicatorCorner: IndicatorCorner
  indicatorOpacity: number

  alwaysShowIndicators: boolean
  soundCues: boolean
}

export interface Settings {
  capture: CaptureSettings
  replay: ReplaySettings
  audio: AudioSettings
  hotkeys: HotkeySettings
  output: OutputSettings
  app: AppSettings
}

export const REPLAY_STEP_SEC = 30
export const REPLAY_MIN_SEC = 60
export const REPLAY_MAX_SEC = 1200

export const DEFAULT_SETTINGS: Settings = {
  capture: {
    monitorId: null,
    fps: 60,
    bitrateKbps: 0,
    codec: 'h264',
    scale: 1,
    preset: 'balanced'
  },
  replay: {
    enabled: false,
    durationSec: 300,
    postRollSec: 3,
    bufferDir: null
  },
  audio: {
    systemEnabled: true,
    systemGain: 1,
    micEnabled: false,
    micDeviceId: null,
    micGain: 1,
    separateTracks: true
  },
  hotkeys: {
    saveReplay: 'Alt+F10',
    toggleRecord: 'Alt+F9',
    toggleReplayBuffer: 'Alt+F8',
    toggleMic: 'Alt+M',
    toggleIndicators: 'Alt+F7'
  },
  output: {
    dir: null,
    filenameTemplate: '{game} {date} - {time}'
  },
  app: {
    minimizeToTray: true,
    launchAtLogin: false,
    theme: 'dark',
    indicatorCorner: 'bottom-right',
    indicatorOpacity: 0.9,
    alwaysShowIndicators: true,
    soundCues: true
  }
}
