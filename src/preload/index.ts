import { contextBridge, ipcRenderer } from 'electron'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch: DeepPartial<Settings>) =>
    ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  getState: () => ipcRenderer.invoke('state:get'),
  listMonitors: () => ipcRenderer.invoke('monitors:list'),

  chooseDirectory: (current: string | null) =>
    ipcRenderer.invoke('dialog:choose-directory', current),
  listMicDevices: () => ipcRenderer.invoke('audio:devices'),
  setMetering: (enabled: boolean) => ipcRenderer.invoke('audio:meter', enabled),
  listAudioApps: () => ipcRenderer.invoke('audio:apps'),
  listClips: () => ipcRenderer.invoke('clips:list'),
  clipMeta: (path: string, mtimeMs: number) => ipcRenderer.invoke('clips:meta', path, mtimeMs),
  revealClip: (path: string) => ipcRenderer.invoke('clips:reveal', path),
  openClip: (path: string) => ipcRenderer.invoke('clips:open', path),
  deleteClip: (path: string) => ipcRenderer.invoke('clips:delete', path),
  revealClipFolder: () => ipcRenderer.invoke('clips:reveal-folder'),

  toggleReplayBuffer: (enabled: boolean) =>
    ipcRenderer.invoke('capture:toggle-replay', enabled) as Promise<void>,
  toggleRecording: () => ipcRenderer.invoke('capture:toggle-record') as Promise<void>,
  saveReplay: () => ipcRenderer.invoke('capture:save-replay') as Promise<void>,

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowClose: () => ipcRenderer.send('window:close'),

  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  }
}

export type CaptureApi = typeof api

contextBridge.exposeInMainWorld('capture', api)
