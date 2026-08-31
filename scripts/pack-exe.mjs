import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const builder = join(root, 'node_modules', '.bin', 'electron-builder.cmd')
const sevenZip = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const appBuilder = join(root, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')

const WIN_CODE_SIGN = 'winCodeSign-2.6.0'
const WIN_CODE_SIGN_URL =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/' +
  `${WIN_CODE_SIGN}/${WIN_CODE_SIGN}.7z`

/*
 * The winCodeSign archive carries two macOS dylib symlinks, and creating a
 * symlink on Windows needs a privilege a normal account does not hold. The
 * extraction electron-builder runs itself dies on them and NSIS never gets to
 * run, so prime the cache by hand: 7za's -snl- writes those two entries as
 * plain files instead of links.
 */
async function primeSigningCache() {
  const cache = join(
    process.env.LOCALAPPDATA ?? '',
    'electron-builder', 'Cache', 'winCodeSign'
  )
  const target = join(cache, WIN_CODE_SIGN)
  if (await stat(join(target, 'rcedit-x64.exe')).catch(() => null)) return

  console.log('priming the winCodeSign cache…')
  const archive = join(cache, `${WIN_CODE_SIGN}.7z`)
  if (!(await stat(archive).catch(() => null))) {
    await mkdir(cache, { recursive: true })
    await run(appBuilder, ['download', '--url', WIN_CODE_SIGN_URL, '--output', archive])
  }

  await rm(target, { recursive: true, force: true })
  await run(sevenZip, ['x', '-snl-', '-bd', archive, `-o${target}`])
}

async function build() {
  await primeSigningCache()
  console.log('packaging…')
  try {
    await run(builder, ['--win', '--config', 'electron-builder.yml'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      shell: true
    })
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || String(error))
  }
}

async function main() {
  await build()

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const exe = join(root, 'release', `CaptureAssistant-${pkg.version}.exe`)

  const info = await stat(exe).catch(() => null)
  if (!info) throw new Error(`packaging produced no ${exe}`)

  const unpacked = join(root, 'release', 'win-unpacked')
  for (const rel of [
    'Capture Assistant.exe',
    'resources/app.asar.unpacked/out/main/supervisor.js',
    'resources/ffmpeg/ffmpeg.exe'
  ]) {
    if (!(await stat(join(unpacked, rel)).catch(() => null))) {
      throw new Error(`missing from the payload: ${rel}`)
    }
  }

  console.log(`${exe}  (${(info.size / 1024 ** 2).toFixed(0)} MB)`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
