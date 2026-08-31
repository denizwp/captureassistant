import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const r = (...p: string[]) => resolve(__dirname, ...p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': r('src/shared'), '@main': r('src/main') } },
    build: {
      rollupOptions: {
        input: {
          index: r('src/main/index.ts'),

          supervisor: r('src/supervisor/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': r('src/shared') } },
    build: {
      rollupOptions: {
        input: {
          index: r('src/preload/index.ts'),
          overlay: r('src/preload/overlay.ts'),
          audio: r('src/preload/audio.ts')
        }
      }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@renderer': r('src/renderer/src'), '@shared': r('src/shared') } },
    build: {
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),

          overlay: r('src/renderer/overlay.html'),
          audio: r('src/renderer/audio.html')
        }
      }
    }
  }
})
