import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, writeFileSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'denizwp/captureassistant'

interface Release {
  version: string
  url: string
  size: number
}

/*
 * The portable build runs from a copy it unpacks into %TEMP%, so process.execPath
 * points at that copy rather than at the file the user actually downloaded. The
 * launcher hands us the real path here, and that is the one an update replaces.
 */
function portableExe(): string | null {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? null
}

function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

async function latestRelease(): Promise<Release | null> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' }
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    tag_name?: string
    assets?: { name: string; browser_download_url: string; size: number }[]
  }

  const version = (body.tag_name ?? '').replace(/^v/, '')
  const asset = body.assets?.find((item) => /\.exe$/i.test(item.name))
  if (!version || !asset) return null

  return { version, url: asset.browser_download_url, size: asset.size }
}

async function download(release: Release, target: string): Promise<void> {
  const response = await fetch(release.url)
  if (!response.ok || !response.body) {
    throw new Error(`sunucu ${response.status} döndü`)
  }

  await rm(target, { force: true })
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target))

  const written = await stat(target)
  if (release.size > 0 && written.size !== release.size) {
    await rm(target, { force: true })
    throw new Error('indirilen dosya eksik')
  }
}

/*
 * The portable launcher keeps its own exe open for as long as the app runs, so
 * it can be neither overwritten nor renamed from inside. Hand the swap to a
 * detached script that retries the move until we are gone.
 */
async function scheduleSwap(exe: string, staged: string, relaunch: boolean): Promise<void> {
  const script = join(app.getPath('temp'), 'ca-apply-update.cmd')
  const lines = [
    '@echo off',
    'set /a tries=0',
    ':retry',
    `move /y "${staged}" "${exe}" >nul 2>&1`,
    'if not errorlevel 1 goto done',
    'set /a tries+=1',
    'if %tries% geq 60 goto give_up',
    'ping -n 2 127.0.0.1 >nul',
    'goto retry',
    ':done',
    ...(relaunch ? [`start "" "${exe}"`] : []),
    'goto cleanup',
    ':give_up',
    `del "${staged}" >nul 2>&1`,
    ':cleanup',
    'del "%~f0" >nul 2>&1'
  ]

  await writeFile(script, `${lines.join('\r\n')}\r\n`, 'utf8')
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export async function discardOldBuild(): Promise<void> {
  const exe = portableExe()
  if (!exe) return
  await rm(`${exe}.new`, { force: true }).catch(() => undefined)
  await rm(`${exe}.old`, { force: true }).catch(() => undefined)
}

export interface UpdateHooks {
  onDownloadStart?: () => void
  onDownloadEnd?: () => void
}

export async function checkForUpdate(hooks: UpdateHooks = {}): Promise<void> {
  const exe = portableExe()
  if (!exe || !app.isPackaged) return

  const release = await latestRelease().catch(() => null)
  if (!release || !isNewer(release.version, app.getVersion())) return

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Güncelle', 'Daha sonra'],
    defaultId: 0,
    cancelId: 1,
    title: 'Capture Assistant',
    message: `Yeni sürüm var: ${release.version}`,
    detail:
      `Şu an ${app.getVersion()} kullanıyorsun. Yeni sürüm indirilip ` +
      'uygulama yeniden başlatılsın mı?'
  })
  if (response !== 0) return

  const staged = `${exe}.new`
  // The download is well over a hundred megabytes and the app looks frozen for
  // the whole of it unless something says otherwise.
  hooks.onDownloadStart?.()
  try {
    await download(release, staged)
    await scheduleSwap(exe, staged, true)
  } catch (error) {
    hooks.onDownloadEnd?.()
    await rm(staged, { force: true }).catch(() => undefined)
    await dialog.showMessageBox({
      type: 'error',
      title: 'Capture Assistant',
      message: 'Güncelleme tamamlanamadı',
      detail: String(error instanceof Error ? error.message : error)
    })
    return
  }

  app.exit(0)
}

export async function runUpdateSelfTest(): Promise<void> {
  const logPath = join(app.getPath('temp'), 'ca-update-selftest.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => appendFileSync(logPath, `${message}\n`)
  log(`log: ${logPath}`)

  const exe = portableExe()
  log(`packaged: ${app.isPackaged}`)
  log(`PORTABLE_EXECUTABLE_FILE: ${exe ?? 'NOT SET'}`)
  log(`running version: ${app.getVersion()}`)
  if (!exe) {
    log('FAILED: no portable path, an update could never be applied')
    return
  }

  const release = await latestRelease().catch(() => null)
  if (!release) {
    log('FAILED: no release found')
    return
  }
  log(`latest release: ${release.version} (${release.size} bytes)`)
  if (!isNewer(release.version, app.getVersion())) {
    log('nothing to do, already current')
    return
  }

  const before = await stat(exe)
  log(`exe before: ${before.size} bytes`)

  const staged = `${exe}.new`
  try {
    await download(release, staged)
    log(`downloaded to ${staged}`)
    await scheduleSwap(exe, staged, false)
    log('swap scheduled, quitting so it can run')
  } catch (error) {
    log(`FAILED: ${String(error instanceof Error ? error.message : error)}`)
  }
}
