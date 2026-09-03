import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Ring, Segment } from './ring'

export interface AssembleRequest {
  from: number

  to: number
  outDir: string
  name: string
  mux: string
  workDir: string
}

export interface AssembleResult {
  path: string
  durationSec: number

  trimmedReason: 'buffer-filling' | 'settings-changed' | null
  /* What the joiner reported about the cut, for the log. */
  note: string | null
}

let jobId = 0

export async function assemble(ring: Ring, request: AssembleRequest): Promise<AssembleResult> {
  const owner = `assemble-${++jobId}`
  const window = ring.window(request.from, request.to)
  if (!window || window.segments.length === 0) {
    throw new Error('Tamponda kaydedilecek görüntü yok.')
  }

  const all = window.segments
  const usable = ring.compatibleFrom(all)
  if (usable.length === 0) throw new Error('Tamponda uyumlu segment yok.')

  const first = usable[0]
  const last = usable.at(-1)
  if (!first || !last) throw new Error('Tamponda uyumlu segment yok.')

  const trimmedReason: AssembleResult['trimmedReason'] =
    usable.length < all.length
      ? 'settings-changed'
      : request.from < ring.oldestStart
        ? 'buffer-filling'
        : null

  const from = Math.max(request.from, first.start)
  const to = Math.min(request.to, last.end)
  const duration = to - from

  ring.pin(first.index, last.index, owner)
  await mkdir(request.outDir, { recursive: true })
  await mkdir(request.workDir, { recursive: true })

  const listPath = join(request.workDir, `${owner}.txt`)
  const outPath = join(request.outDir, `${request.name}.mp4`)

  let keepList = false
  try {
    /*
     * Copying pictures rather than re-encoding them means the clip can only
     * begin on a keyframe, which the engine emits twice a second — close enough
     * that nobody notices, and without the risk of a re-encoded head whose
     * parameters do not match the segments behind it.
     */
    const lines = usable.map((segment: Segment) => segment.file)
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8')
    const said = await run(request.mux, [
      'concat',
      '--list', listPath,
      '--out', outPath,
      '--start', Math.max(0, from - first.start).toFixed(3),
      '--duration', duration.toFixed(3)
    ])
    return { path: outPath, durationSec: duration, trimmedReason, note: said }
  } catch (error) {
    // The list names the exact segments a failed join was given, which is the
    // only way to reproduce it once the ring has moved on.
    keepList = true
    throw error
  } finally {
    ring.unpin(owner)
    if (!keepList) await rm(listPath, { force: true })
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stderr.trim())
      else reject(new Error(`${basename(command)} ${code}: ${stderr.trim().slice(0, 400)}`))
    })
  })
}
