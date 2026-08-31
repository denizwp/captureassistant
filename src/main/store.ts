import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { DeepPartial } from '@shared/ipc'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Merges a patch into a base, keeping any key the patch does not mention. */
function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!isPlainObject(patch)) return base
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? merge(current, value) : value
  }
  return out as T
}

export class SettingsStore {
  private readonly file: string
  private value: Settings

  constructor(file = join(app.getPath('userData'), 'settings.json')) {
    this.file = file
    this.value = this.read()
  }

  get(): Settings {
    return this.value
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.value = merge(this.value, patch)
    this.write()
    return this.value
  }

  private read(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as DeepPartial<Settings>
      // Merge onto defaults so a settings file written by an older version
      // picks up new keys instead of leaving them undefined.
      return merge(DEFAULT_SETTINGS, raw)
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  /** Write to a sibling temp file then rename, so a crash mid-write can't
   *  leave a truncated settings file behind. */
  private write(): void {
    const tmp = `${this.file}.tmp`
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
