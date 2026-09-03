import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureSettings } from '@shared/settings'
import { PRESET_MAXRATE_KBPS, SEGMENT_SEC } from './pipeline'

/*
 * The native engine reports each finished segment on stdout in the same shape
 * ffmpeg's segment muxer wrote into index.csv. Appending those lines to that
 * same file is what lets the ring stay exactly as it was, whichever engine is
 * running underneath.
 */
export const NATIVE_EXIT_SIZE_CHANGED = 10
export const NATIVE_EXIT_SETUP = 12

export interface NativeArgsInput {
  capture: CaptureSettings
  outputIdx: number
  ringDir: string
  startNumber: number
  drawMouse: boolean
  audioPipe: string | null
}

export function buildNativeArgs(input: NativeArgsInput): string[] {
  const { capture, outputIdx, ringDir, startNumber, drawMouse, audioPipe } = input
  const maxrateKbps =
    capture.bitrateKbps > 0 ? capture.bitrateKbps : PRESET_MAXRATE_KBPS[capture.preset]

  return [
    '--dir', ringDir,
    '--monitor', String(outputIdx),
    '--fps', String(capture.fps),
    '--bitrate', String(maxrateKbps),
    '--segment-sec', String(SEGMENT_SEC),
    '--start', String(startNumber),
    ...(capture.codec === 'hevc' ? ['--hevc'] : []),
    ...(drawMouse ? [] : ['--no-cursor']),
    ...(audioPipe ? ['--audio-pipe', audioPipe] : [])
  ]
}

export interface NativeStats {
  frames: number
  dropped: number
  rejected: number
  produced: number
  wall: number
}

export interface NativeEvents {
  onSegment: (line: string) => void
  onStats: (stats: NativeStats) => void
  onReady: (line: string) => void
}

/* Splits the engine's stdout into the three kinds of line it emits. */
export function createNativeReader(events: NativeEvents): (chunk: string) => void {
  let carry = ''
  return (chunk: string): void => {
    const lines = (carry + chunk).split('\n')
    carry = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('seg_')) {
        events.onSegment(line)
      } else if (line.startsWith('stat ')) {
        const read = (key: string): number => {
          const match = new RegExp(`${key}=([0-9.]+)`).exec(line)
          return match?.[1] ? Number(match[1]) : 0
        }
        events.onStats({
          frames: read('frames'),
          dropped: read('dropped'),
          rejected: read('rejected'),
          produced: read('produced'),
          wall: read('wall')
        })
      } else if (line.startsWith('ready ')) {
        events.onReady(line)
      }
    }
  }
}

export async function appendSegmentLine(ringDir: string, line: string): Promise<void> {
  await appendFile(join(ringDir, 'index.csv'), `${line}\n`, 'utf8')
}
