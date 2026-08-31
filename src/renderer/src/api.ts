import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { SupervisorState } from '@shared/state'

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
