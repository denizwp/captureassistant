import { app, dialog } from 'electron'
import type { UpdateChannel } from '@shared/settings'
import { write } from './log'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, createReadStream, createWriteStream, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'denizwp/captureassistant'

interface Release {
  version: string
  url: string
  size: number
  /* Base64 SHA-512 of the installer, from the manifest published beside it. */
  sha512: string | null
  channel: UpdateChannel
}

/*
 * Where the downloaded installer is staged. Named after the version so a run
 * that was interrupted leaves something recognisable behind rather than a
 * generic file nobody can place.
 */
function stagedInstaller(version: string): string {
  return join(app.getPath('temp'), `CaptureAssistant-${version}.exe`)
}

/*
 * Compares 1.2.3 and 1.2.3-canary.4. Numbers decide first; when those match, a
 * plain version is newer than a pre-release of the same number, since the test
 * builds come before the release they lead to.
 */
function isNewer(candidate: string, current: string): boolean {
  const parse = (
    value: string
  ): { parts: number[]; pre: string | null; preNumber: number } => {
    const [core = '', pre = ''] = value.split('-', 2)
    const preNumber = Number(/(\d+)$/.exec(pre)?.[1] ?? 0)
    return { parts: core.split('.').map(Number), pre: pre || null, preNumber }
  }

  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    const x = a.parts[i] ?? 0
    const y = b.parts[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x > y
  }
  if (a.pre === b.pre) return a.preNumber > b.preNumber
  if (!a.pre) return true
  if (!b.pre) return false
  return a.preNumber > b.preNumber
}

interface GithubRelease {
  tag_name?: string
  prerelease?: boolean
  assets?: { name: string; browser_download_url: string; size: number }[]
}

async function get(path: string): Promise<unknown | null> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { accept: 'application/vnd.github+json' }
  })
  if (!response.ok) return null
  return response.json()
}

/*
 * The manifest electron-builder publishes beside the installer. It carries the
 * checksum, which is the only way to tell a build that arrived intact from one
 * that was truncated by a dropped connection or rewritten in transit.
 */
async function checksumFrom(url: string): Promise<string | null> {
  const response = await fetch(url).catch(() => null)
  if (!response?.ok) return null
  const text = await response.text()
  return /^sha512:\s*(\S+)/m.exec(text)?.[1] ?? null
}

async function latestRelease(channel: UpdateChannel): Promise<Release | null> {
  let body: GithubRelease | null = null

  if (channel === 'canary') {
    body = (await get('releases/tags/canary')) as GithubRelease | null
    if (!body) {
      const all = ((await get('releases?per_page=15')) as GithubRelease[] | null) ?? []
      body = all.find((item) => item.prerelease) ?? null
    }
  }
  // Falls back to stable when the canary channel has nothing published, so
  // choosing it never leaves someone stranded on an old build.
  if (!body) body = (await get('releases/latest')) as GithubRelease | null
  if (!body) return null

  const version = (body.tag_name ?? '').replace(/^v/, '')
  const asset = body.assets?.find((item) => /\.exe$/i.test(item.name))
  if (!version || !asset) return null

  const manifest = body.assets?.find((item) => /^latest.*\.yml$/i.test(item.name))
  const sha512 = manifest ? await checksumFrom(manifest.browser_download_url) : null

  return {
    version,
    url: asset.browser_download_url,
    size: asset.size,
    sha512,
    channel: body.prerelease ? 'canary' : 'stable'
  }
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

  /*
   * Nothing is run until the bytes are the bytes that were published. A build
   * that half arrived is the exact shape of an installer that leaves the app
   * broken, and it is cheap to refuse it here instead.
   */
  if (release.sha512) {
    const digest = await sha512Of(target)
    if (digest !== release.sha512) {
      await rm(target, { force: true })
      throw new Error('indirilen dosya doğrulanamadı')
    }
    write(`update ${release.version}: checksum verified`)
  } else {
    write(`update ${release.version}: published without a checksum, size checked only`)
  }
}

function sha512Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
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
    if (/^CaptureAssistant-[0-9.a-z-]+\.exe$/i.test(name)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }
}

export interface UpdateHooks {
  onDownloadStart?: () => void
  onDownloadEnd?: () => void
}

export async function checkForUpdate(
  channel: UpdateChannel,
  hooks: UpdateHooks = {}
): Promise<void> {
  if (!app.isPackaged) return

  const release = await latestRelease(channel).catch(() => null)
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

export async function runUpdateSelfTest(channel: UpdateChannel = 'stable'): Promise<void> {
  const logPath = join(app.getPath('temp'), 'ca-update-selftest.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => appendFileSync(logPath, `${message}\n`)
  log(`log: ${logPath}`)

  /* Ordering rules first: they decide whether an update is offered at all. */
  const order: [string, string, boolean][] = [
    ['0.2.2', '0.2.1', true],
    ['0.2.1', '0.2.1', false],
    ['0.2.0', '0.2.1', false],
    ['0.3.0-canary.1', '0.2.1', true],
    ['0.3.0', '0.3.0-canary.4', true],
    ['0.3.0-canary.4', '0.3.0', false],
    ['0.3.0-canary.5', '0.3.0-canary.4', true],
    ['1.0.0', '0.9.9', true]
  ]
  let bad = 0
  for (const [candidate, current, want] of order) {
    const got = isNewer(candidate, current)
    if (got !== want) {
      bad++
      log(`  FAILED: ${candidate} vs ${current} — ${got}, beklenen ${want}`)
    }
  }
  log(bad === 0 ? `  OK: sürüm sıralaması (${order.length} durum)` : `  ${bad} sıralama hatası`)

  log(`packaged: ${app.isPackaged}`)
  log(`install path: ${process.execPath}`)
  log(`running version: ${app.getVersion()}`)
  log(`channel: ${channel}`)
  if (!app.isPackaged) {
    log('FAILED: not a packaged build, an update could never be applied')
    return
  }

  const release = await latestRelease(channel).catch(() => null)
  if (!release) {
    log('FAILED: no release found')
    return
  }
  log(`latest release: ${release.version} (${release.size} bytes, ${release.channel})`)
  log(`checksum published: ${release.sha512 ? release.sha512.slice(0, 24) + '…' : 'HAYIR'}`)
  if (!isNewer(release.version, app.getVersion())) {
    log('nothing to do, already current')
    return
  }

  const staged = stagedInstaller(release.version)
  try {
    await download(release, staged)
    const written = await stat(staged)
    log(`downloaded and verified ${written.size} bytes to ${staged}`)
    log('installer staged; not running it, this is a dry run')
  } catch (error) {
    log(`FAILED: ${String(error instanceof Error ? error.message : error)}`)
  }
}
