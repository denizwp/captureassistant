import { execFile } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const unpacked = join(root, 'release', 'win-unpacked')
const sevenZip = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const builder = join(root, 'node_modules', '.bin', 'electron-builder.cmd')

async function packageApp() {
  console.log('packaging…')
  try {
    await run(builder, ['--win', '--dir', '--config', 'electron-builder.yml'], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      shell: true
    })
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const onlySymlinks = output.includes('Cannot create symbolic link')
    if (!onlySymlinks) throw error
    console.log('  (ignored winCodeSign symlink failure — see the note in this file)')
  }
}

async function main() {
  await packageApp()

  const dir = await stat(unpacked).catch(() => null)
  if (!dir?.isDirectory()) throw new Error('packaging produced no release/win-unpacked')

  const exe = await stat(join(unpacked, 'Capture Assistant.exe')).catch(() => null)
  if (!exe) throw new Error('release/win-unpacked has no executable')

  const supervisor = await stat(
    join(unpacked, 'resources', 'app.asar.unpacked', 'out', 'main', 'supervisor.js')
  ).catch(() => null)
  if (!supervisor) throw new Error('supervisor.js was not unpacked from the asar')

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const out = join(root, 'release', `Capture Assistant-${pkg.version}-win-x64.zip`)

  await rm(out, { force: true })
  console.log('zipping…')

  await run(sevenZip, ['a', '-tzip', '-mx=5', out, '.\\*'], {
    cwd: unpacked,
    maxBuffer: 32 * 1024 * 1024
  })

  const { size } = await stat(out)
  console.log(`${out}  (${(size / 1024 ** 2).toFixed(0)} MB)`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
