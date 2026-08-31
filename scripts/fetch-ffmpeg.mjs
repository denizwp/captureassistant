/**
 * Downloads the FFmpeg binaries the app shells out to.
 *
 * They are not committed — ffmpeg.exe and ffprobe.exe are ~145 MB each. Run
 * `npm run fetch:ffmpeg` after cloning.
 *
 * The build has to carry ddagrab (Desktop Duplication) plus the NVENC/AMF/QSV
 * encoders, which rules out the LGPL builds. BtbN's win64-gpl is the one this
 * project is verified against.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rm, readdir, copyFile, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'resources', 'ffmpeg')
const tmp = join(root, 'node_modules', '.cache', 'ffmpeg')

const URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false
  )

async function main() {
  if ((await exists(join(dest, 'ffmpeg.exe'))) && (await exists(join(dest, 'ffprobe.exe')))) {
    console.log('ffmpeg already present in resources/ffmpeg — nothing to do')
    return
  }

  await mkdir(tmp, { recursive: true })
  await mkdir(dest, { recursive: true })

  const zip = join(tmp, 'ffmpeg.zip')
  console.log(`downloading ${URL}`)
  const response = await fetch(URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(zip))

  const unpacked = join(tmp, 'unpacked')
  await rm(unpacked, { recursive: true, force: true })
  console.log('extracting')
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${zip}' -DestinationPath '${unpacked}' -Force`
  ])

  // The archive nests everything under a single versioned directory.
  const [top] = await readdir(unpacked)
  if (!top) throw new Error('archive was empty')
  const bin = join(unpacked, top, 'bin')

  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    await copyFile(join(bin, exe), join(dest, exe))
    console.log(`installed ${exe}`)
  }

  const { stdout } = await run(join(dest, 'ffmpeg.exe'), ['-hide_banner', '-version'])
  console.log(stdout.split('\n')[0])

  await rm(tmp, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
