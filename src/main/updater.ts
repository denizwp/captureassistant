import { app, dialog } from 'electron'
import { createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'denizwp/captureassistant'
const OLD_SUFFIX = '.old'

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

export async function discardOldBuild(): Promise<void> {
  const exe = portableExe()
  if (!exe) return
  await rm(`${exe}${OLD_SUFFIX}`, { force: true }).catch(() => undefined)
}

export async function checkForUpdate(): Promise<void> {
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
  try {
    await download(release, staged)
    // Windows will not overwrite a running exe but it will happily rename one.
    await rename(exe, `${exe}${OLD_SUFFIX}`)
    await rename(staged, exe)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    await dialog.showMessageBox({
      type: 'error',
      title: 'Capture Assistant',
      message: 'Güncelleme tamamlanamadı',
      detail: String(error instanceof Error ? error.message : error)
    })
    return
  }

  app.relaunch({ execPath: exe })
  app.exit(0)
}
