import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ffmpegPath } from './supervisor'

const run = promisify(execFile)

function cacheDir(): string {
  return join(app.getPath('userData'), 'thumbs')
}

/**
 * One frame per clip, cached beside the app data.
 *
 * Keyed on path plus mtime so a clip that is replaced under the same name gets
 * a fresh frame instead of a stale one, and generated lazily: the gallery has
 * to render immediately, not wait on ffmpeg for every file in the folder.
 */
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
        // A second in, so the frame is not whatever black the clip opens on.
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
    // A clip shorter than the seek point, or one still being written. Not worth
    // surfacing — the card just shows its placeholder.
    return null
  }

  const written = await stat(out).catch(() => null)
  return written && written.size > 0 ? out : null
}
