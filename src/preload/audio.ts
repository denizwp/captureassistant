import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('audioBridge', {
  /** Raw interleaved f32le blocks on their way to the ffmpeg named pipe. */
  writePcm: (buffer: ArrayBuffer) => ipcRenderer.send('audio:pcm', buffer),
  ready: () => ipcRenderer.send('audio:ready'),
  status: (payload: unknown) => ipcRenderer.send('audio:status', payload),
  on: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on('audio:command', wrapped)
    return () => ipcRenderer.off('audio:command', wrapped)
  }
})
