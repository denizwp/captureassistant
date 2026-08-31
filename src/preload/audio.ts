import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('audioBridge', {
  /** Raw interleaved f32le blocks on their way to the ffmpeg named pipe. */
  writePcm: (buffer: ArrayBuffer) => ipcRenderer.send('audio:pcm', buffer),
  ready: () => ipcRenderer.send('audio:ready'),
  on: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on('audio:config', wrapped)
    return () => ipcRenderer.off('audio:config', wrapped)
  }
})
