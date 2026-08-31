import { useCallback, useEffect, useState } from 'react'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { api } from './api'

/**
 * Settings live in the main process. The renderer holds a copy for rendering
 * and sends patches; main is the single writer and echoes the merged result
 * back on the `settings` channel, so two open windows can't drift apart.
 */
export function useSettings(): {
  settings: Settings | null
  patch: (next: DeepPartial<Settings>) => void
} {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    return api.on('settings', (payload) => setSettings(payload as Settings))
  }, [])

  const patch = useCallback((next: DeepPartial<Settings>) => {
    // Optimistic: the echo from main will confirm or correct it.
    setSettings((current) => (current ? mergeLocal(current, next) : current))
    void api.setSettings(next)
  }, [])

  return { settings, patch }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function mergeLocal<T>(base: T, patch: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeLocal(current, value as DeepPartial<typeof current>)
        : value
  }
  return out as T
}
