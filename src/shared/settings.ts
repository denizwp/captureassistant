/**
 * Persisted settings shape. Every field here is user-visible somewhere in the
 * UI; anything derived (encoder choice, ring size in bytes) is computed at
 * runtime and deliberately NOT stored, so a hardware change can't leave us
 * pinned to an encoder that no longer exists.
 */

export type CodecId = 'h264' | 'hevc' | 'av1'
export type QualityPreset = 'low' | 'balanced' | 'high'
export type IndicatorCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface CaptureSettings {
  /** DXGI output id, resolved to (adapter, output) at arm time. */
  monitorId: string | null
  fps: number
  /** 0 means "derive from preset". */
  bitrateKbps: number
  codec: CodecId
  /** 1 = native resolution, 0.75 / 0.5 downscale on the GPU. */
  scale: number
  preset: QualityPreset
}

export interface ReplaySettings {
  enabled: boolean
  /** 60..1200 seconds, always a multiple of 30 (the 30s slider step). */
  durationSec: number
  /** Seconds captured *after* the hotkey press. */
  postRollSec: number
  /** null = <userData>/ring */
  bufferDir: string | null
}

export interface AudioSettings {
  systemEnabled: boolean
  systemGain: number
  micEnabled: boolean
  /** WASAPI/Chromium device id; null = system default. */
  micDeviceId: string | null
  micGain: number
  /** Write System and Mic as extra tracks alongside the mix. */
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
  /** Tokens: {app} {game} {date} {time} */
  filenameTemplate: string
}

export interface AppSettings {
  minimizeToTray: boolean
  launchAtLogin: boolean
  theme: 'dark' | 'light'
  indicatorCorner: IndicatorCorner
  indicatorOpacity: number
  /** Keep badges up even over a fullscreen game. Costs FPS; off by default. */
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
    alwaysShowIndicators: false,
    soundCues: true
  }
}
