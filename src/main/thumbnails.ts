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
