import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { muxPath } from './supervisor'

const run = promisify(execFile)

function cacheDir(): string {
  return join(app.getPath('userData'), 'thumbs')
}

const durations = new Map<string, number>()

export async function thumbnailFor(clipPath: string, mtimeMs: number): Promise<string | null> {
  const key = createHash('sha1').update(`${clipPath}:${mtimeMs}`).digest('hex').slice(0, 16)
  const out = join(cacheDir(), `${key}.jpg`)

  const existing = await stat(out).catch(() => null)
  if (existing && existing.size > 0) return out

  await mkdir(cacheDir(), { recursive: true })
  try {
    // The same call reports how long the clip runs, so the gallery gets both
    // the picture and the length for the price of opening the file once.
    const { stdout } = await run(
      muxPath(),
      ['thumb', '--in', clipPath, '--out', out, '--at', '1', '--width', '480'],
      { timeout: 15_000 }
    )
    const seconds = /duration=([0-9.]+)/.exec(stdout)
    if (seconds) durations.set(`${clipPath}:${mtimeMs}`, Number(seconds[1]))
  } catch {
    return null
  }

  const written = await stat(out).catch(() => null)
  return written && written.size > 0 ? out : null
}

export async function durationFor(clipPath: string, mtimeMs: number): Promise<number> {
  const key = `${clipPath}:${mtimeMs}`
  const cached = durations.get(key)
  if (cached !== undefined) return cached

  // Reading the header alone, with no output file asked for, so this costs an
  // open and a seek rather than a decode.
  try {
    const { stdout } = await run(muxPath(), ['thumb', '--in', clipPath], { timeout: 10_000 })
    const match = /duration=([0-9.]+)/.exec(stdout)
    const value = match ? Number(match[1]) : 0
    if (!Number.isFinite(value)) return 0
    durations.set(key, value)
    return value
  } catch {
    return 0
  }
}

const MAX_THUMBS = 300

export async function pruneThumbnails(): Promise<number> {
  const dir = cacheDir()
  const names = await readdir(dir).catch(() => [] as string[])
  if (names.length <= MAX_THUMBS) return 0

  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      return { path, mtime: info?.mtimeMs ?? 0 }
    })
  )

  const stale = entries.sort((a, b) => b.mtime - a.mtime).slice(MAX_THUMBS)
  for (const entry of stale) await rm(entry.path, { force: true }).catch(() => undefined)
  return stale.length
}
