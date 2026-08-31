import { contextBridge, ipcRenderer } from 'electron'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch: DeepPartial<Settings>) =>
    ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  getState: () => ipcRenderer.invoke('state:get'),
  listMonitors: () => ipcRenderer.invoke('monitors:list'),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowClose: () => ipcRenderer.send('window:close'),

  /** Returns an unsubscribe function so React effects can clean up. */
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  }
}

export type CaptureApi = typeof api

contextBridge.exposeInMainWorld('capture', api)
