import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { Clip, SupervisorState } from '@shared/state'

export interface MonitorInfo {
  id: string
  label: string
  width: number
  height: number
}

interface CaptureApi {
  getSettings(): Promise<Settings>
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>
  getState(): Promise<SupervisorState>
  listMonitors(): Promise<MonitorInfo[]>
  chooseDirectory(current: string | null): Promise<string | null>
  listMicDevices(): Promise<{ id: string; label: string }[]>
  listClips(): Promise<Clip[]>
  clipMeta(
    path: string,
    mtimeMs: number
  ): Promise<{ thumbnail: string | null; durationSec: number }>
  revealClip(path: string): Promise<void>
  openClip(path: string): Promise<void>
  deleteClip(path: string): Promise<void>
  revealClipFolder(): Promise<void>
  toggleReplayBuffer(enabled: boolean): Promise<void>
  toggleRecording(): Promise<void>
  saveReplay(): Promise<void>
  windowMinimize(): void
  windowClose(): void
  on(channel: string, listener: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    capture: CaptureApi
  }
}

export const api = window.capture
