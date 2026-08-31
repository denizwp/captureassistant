import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlay', {
  on: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on('overlay:state', wrapped)
    return () => ipcRenderer.off('overlay:state', wrapped)
  }
})
