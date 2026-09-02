import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ffmpegPath } from './supervisor'

const run = promisify(execFile)

function cacheDir(): string {
  return join(app.getPath('userData'), 'thumbs')
}

export async function thumbnailFor(clipPath: string, mtimeMs: number): Promise<string | null> {
  const key = createHash('sha1').update(`${clipPath}:${mtimeMs}`).digest('hex').slice(0, 16)
  const out = join(cacheDir(), `${key}.jpg`)

  const existing = await stat(out).catch(() => null)
  if (existing && existing.size > 0) return out

  await mkdir(cacheDir(), { recursive: true })
  try {
    await run(
      ffmpegPath(),
      [
        '-hide_banner',
        '-v', 'error',

        '-ss', '1',
        '-i', clipPath,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-q:v', '4',
        '-y',
        out
      ],
      { timeout: 15_000 }
    )
  } catch {
    return null
  }

  const written = await stat(out).catch(() => null)
  return written && written.size > 0 ? out : null
}

const durations = new Map<string, number>()

export async function durationFor(clipPath: string, mtimeMs: number): Promise<number> {
  const key = `${clipPath}:${mtimeMs}`
  const cached = durations.get(key)
  if (cached !== undefined) return cached

  /*
   * Read from ffmpeg rather than ffprobe: asking for no output makes it print
   * the header and stop, which takes about a tenth of a second, and it keeps a
   * second 139MB binary out of the package.
   */
  try {
    await run(ffmpegPath(), ['-hide_banner', '-i', clipPath], { timeout: 10_000 })
    return 0
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const match = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr)
    if (!match) return 0
    const seconds =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    const value = Number.isFinite(seconds) ? seconds : 0
    durations.set(key, value)
    return value
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
