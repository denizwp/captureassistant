import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from '@shared/settings'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  getState: () => ipcRenderer.invoke('state:get'),
  listClips: () => ipcRenderer.invoke('clips:list'),
  clipMeta: (path: string, mtimeMs: number) => ipcRenderer.invoke('clips:meta', path, mtimeMs),
  openClip: (path: string) => ipcRenderer.invoke('clips:open', path),

  toggleReplayBuffer: (enabled: boolean) => ipcRenderer.invoke('capture:toggle-replay', enabled),
  toggleRecording: () => ipcRenderer.invoke('capture:toggle-record'),
  saveReplay: () => ipcRenderer.invoke('capture:save-replay'),
  toggleMic: () => ipcRenderer.invoke('capture:toggle-mic'),

  openSettings: () => ipcRenderer.send('hud:open-settings'),
  close: () => ipcRenderer.send('hud:close'),

  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  }
}

export type HudApi = typeof api

contextBridge.exposeInMainWorld('hud', api)
