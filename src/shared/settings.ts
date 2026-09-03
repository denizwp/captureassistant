export type CodecId = 'h264' | 'hevc' | 'av1'
export type QualityPreset = 'low' | 'balanced' | 'high'
export type IndicatorCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export type CaptureMethod = 'native' | 'auto' | 'gdi'

export interface CaptureSettings {
  monitorId: string | null
  fps: number

  bitrateKbps: number
  codec: CodecId

  preset: QualityPreset

  /*
   * 'native' is our own engine on Windows.Graphics.Capture: it stamps frames
   * with when they were captured, drops one rather than falling behind the
   * clock, and turns segments over on a timer so a still screen cannot stall
   * the buffer. 'auto' is the older ffmpeg path on Desktop Duplication, and
   * 'gdi' the BitBlt fallback that works everywhere at about ten times the CPU.
   */
  method: CaptureMethod
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

  /*
   * Executable names, not pids — pids change every launch. Empty means record
   * everything, which is also the cheapest path.
   */
  micEnabled: boolean

  micDeviceId: string | null
  micGain: number

}

export interface HotkeySettings {
  saveReplay: string
  toggleRecord: string
  toggleReplayBuffer: string
  toggleMic: string
  toggleIndicators: string
  toggleHud: string
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
  showCharacterArt: boolean
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
    preset: 'balanced',
    method: 'native'
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
    micGain: 1
  },
  hotkeys: {
    saveReplay: 'Alt+F10',
    toggleRecord: 'Alt+F9',
    toggleReplayBuffer: 'Alt+F8',
    toggleMic: 'Alt+M',
    toggleIndicators: 'Alt+F7',
    toggleHud: 'Alt+Z'
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
    showCharacterArt: false
  }
}
