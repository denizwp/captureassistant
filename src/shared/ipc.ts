import type { Settings } from './settings'
import type { Clip, SupervisorState } from './state'

/** Renderer -> main, request/response. */
export interface RendererApi {
  getSettings(): Promise<Settings>
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>
  getState(): Promise<SupervisorState>

  toggleReplayBuffer(enabled: boolean): Promise<void>
  toggleRecording(): Promise<void>
  saveReplay(): Promise<void>

  listClips(): Promise<Clip[]>
  revealClip(id: string): Promise<void>
  openClip(id: string): Promise<void>
  deleteClip(id: string): Promise<void>
  renameClip(id: string, name: string): Promise<void>

  listMonitors(): Promise<{ id: string; label: string; width: number; height: number }[]>
  chooseDirectory(current: string | null): Promise<string | null>

  windowMinimize(): void
  windowClose(): void
}

/** Main -> renderer, push only. */
export interface RendererEvents {
  state: SupervisorState
  settings: Settings
  clips: Clip[]
  toast: { kind: 'info' | 'success' | 'warning' | 'error'; message: string }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
