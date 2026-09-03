import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
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
 * Where the downloaded installer is staged. Named after the version so a run
 * that was interrupted leaves something recognisable behind rather than a
 * generic file nobody can place.
 */
function stagedInstaller(version: string): string {
  return join(app.getPath('temp'), `CaptureAssistant-${version}.exe`)
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

async function applyUpdate(installer: string): Promise<void> {
  // /S installs silently over the existing copy; without --force-run it would
  // leave the app closed once it is done, which reads as the update having
  // killed it.
  const child = spawn(installer, ['/S', '--force-run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => undefined)
  child.unref()
}

export async function discardOldBuild(): Promise<void> {
  // Installers left behind by an interrupted update; the running one is already
  // gone by the time this runs.
  const dir = app.getPath('temp')
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (/^CaptureAssistant-[0-9.]+\.exe$/i.test(name)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }
}

export interface UpdateHooks {
  onDownloadStart?: () => void
  onDownloadEnd?: () => void
}

export async function checkForUpdate(hooks: UpdateHooks = {}): Promise<void> {
  if (!app.isPackaged) return

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

  const staged = stagedInstaller(release.version)
  // The download is a hundred megabytes and the app looks frozen for the whole
  // of it unless something says otherwise.
  hooks.onDownloadStart?.()
  try {
    await download(release, staged)
    await applyUpdate(staged)
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

  log(`packaged: ${app.isPackaged}`)
  log(`install path: ${process.execPath}`)
  log(`running version: ${app.getVersion()}`)
  if (!app.isPackaged) {
    log('FAILED: not a packaged build, an update could never be applied')
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

  const staged = stagedInstaller(release.version)
  try {
    await download(release, staged)
    const written = await stat(staged)
    log(`downloaded ${written.size} bytes to ${staged}`)
    log('installer staged; not running it, this is a dry run')
  } catch (error) {
    log(`FAILED: ${String(error instanceof Error ? error.message : error)}`)
  }
}
