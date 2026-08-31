import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodecId } from '@shared/settings'
import type { EncoderChoice } from './pipeline'

const run = promisify(execFile)

const CANDIDATES: Record<CodecId, string[]> = {
  h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'],
  hevc: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'libx265'],
  av1: ['av1_nvenc', 'av1_amf', 'av1_qsv']
}

const SOFTWARE = new Set(['libx264', 'libx265'])

export interface ProbeResult {
  encoder: EncoderChoice

  rejected: { id: string; reason: string }[]
}

export async function probeEncoder(ffmpeg: string, codec: CodecId): Promise<ProbeResult> {
  const listed = await listEncoders(ffmpeg)
  const rejected: { id: string; reason: string }[] = []

  for (const id of CANDIDATES[codec]) {
    if (!listed.has(id)) {
      rejected.push({ id, reason: 'bu ffmpeg derlemesinde yok' })
      continue
    }
    const failure = await smokeTest(ffmpeg, id)
    if (failure) {
      rejected.push({ id, reason: failure })
      continue
    }
    return { encoder: { id, hardware: !SOFTWARE.has(id) }, rejected }
  }

  return { encoder: { id: 'libx264', hardware: false }, rejected }
}

async function listEncoders(ffmpeg: string): Promise<Set<string>> {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-encoders'], {
    maxBuffer: 4 * 1024 * 1024
  }).catch(() => ({ stdout: '' }))

  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
    if (match?.[1]) names.add(match[1])
  }
  return names
}

async function smokeTest(ffmpeg: string, id: string): Promise<string | null> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=1920x1080:rate=60:duration=0.5',
    '-c:v', id,
    ...(id.endsWith('_nvenc') ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '25', '-b:v', '0'] : []),
    ...(id.endsWith('_amf') ? ['-usage', 'transcoding', '-quality', 'speed'] : []),
    ...(id.endsWith('_qsv') ? ['-preset', 'veryfast'] : []),
    ...(SOFTWARE.has(id) ? ['-preset', 'ultrafast'] : []),
    '-f', 'null',
    '-'
  ]

  try {
    await run(ffmpeg, args, { timeout: 30_000 })
    return null
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    return stderr.trim().split('\n').at(-1)?.slice(0, 160) ?? 'bilinmeyen hata'
  }
}

export async function probeCapture(ffmpeg: string, outputIdx: number): Promise<string | null> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-init_hw_device', `d3d11va=dda:${outputIdx}`,
    '-filter_hw_device', 'dda',
    '-filter_complex', `ddagrab=output_idx=${outputIdx}:framerate=30:allow_fallback=1,hwdownload,format=bgra[v]`,
    '-map', '[v]',
    '-frames:v', '4',
    '-f', 'null',
    '-'
  ]
  try {
    await run(ffmpeg, args, { timeout: 20_000 })
    return null
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    return stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? 'ekran yakalanamadı'
  }
}
