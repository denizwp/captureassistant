import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('audioBridge', {
  writePcm: (buffer: ArrayBuffer) => ipcRenderer.send('audio:pcm', buffer),
  ready: () => ipcRenderer.send('audio:ready'),
  status: (payload: unknown) => ipcRenderer.send('audio:status', payload),
  levels: (payload: unknown) => ipcRenderer.send('audio:levels', payload),
  on: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on('audio:command', wrapped)
    return () => ipcRenderer.off('audio:command', wrapped)
  }
})
