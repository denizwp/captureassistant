import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureSettings } from '@shared/settings'
import { buildAssembleArgs, buildHeadArgs, type EncoderChoice } from './pipeline'
import type { Ring, Segment } from './ring'

export interface AssembleRequest {
  from: number

  to: number
  outDir: string
  name: string
  encoder: EncoderChoice
  capture: CaptureSettings
  ffmpeg: string
  workDir: string
}

export interface AssembleResult {
  path: string
  durationSec: number

  trimmedReason: 'buffer-filling' | 'settings-changed' | null
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

  const headPath = join(request.workDir, `${owner}.ts`)
  const outPath = join(request.outDir, `${request.name}.mp4`)

  try {
    const offsetIntoFirst = from - first.start
    let head: string | null = null
    if (offsetIntoFirst > 0.001) {
      await run(request.ffmpeg, [
        ...buildHeadArgs({
          segmentPath: first.file,
          startTime: from,
          encoder: request.encoder,
          capture: request.capture,
          outPath: headPath
        })
      ])
      const written = await stat(headPath).catch(() => null)
      if (written && written.size > 0) head = headPath
    }

    const tail = head ? usable.slice(1) : usable
    await concatInto(request.ffmpeg, buildAssembleArgs({ durationSec: duration, outPath }), [
      ...(head ? [head] : []),
      ...tail.map((segment: Segment) => segment.file)
    ])

    return { path: outPath, durationSec: duration, trimmedReason }
  } finally {
    ring.unpin(owner)
    await rm(headPath, { force: true })
  }
}

async function concatInto(ffmpeg: string, args: string[], files: string[]): Promise<void> {
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const finished = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg ${code}: ${stderr.trim().slice(0, 400)}`))
    })
  })

  const stdin = child.stdin!
  try {
    for (const file of files) {
      for await (const chunk of createReadStream(file)) {
        if (!stdin.write(chunk as Buffer)) {
          await new Promise<void>((resolve) => stdin.once('drain', resolve))
        }
      }
    }
    stdin.end()
  } catch (error) {
    child.kill()
    throw error
  }

  await finished
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg ${code}: ${stderr.trim().slice(0, 400)}`))
    })
  })
}
