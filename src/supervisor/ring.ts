import { open, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SEGMENT_SEC } from './pipeline'

export interface Segment {
  index: number
  file: string

  start: number
  end: number
  runId: number
  bytes: number
}

export interface Run {
  id: number
  firstSegment: number
  lastSegment: number | null
  width: number
  height: number
  fps: number
  codec: string
}

interface Pin {
  lo: number

  hi: number | null
  owner: string
  expiresAt: number
}

export interface RingStats {
  segmentCount: number
  bufferedSec: number
  bytesOnDisk: number
  bytesPerSec: number
  freeDiskBytes: number
}

const PIN_TTL_MS = 5 * 60_000

export class Ring {
  private segments: Segment[] = []
  private pins: Pin[] = []
  private runs: Run[] = []
  private csvOffset = 0
  private carry = ''
  private runId = 0
  private lastBytes = 0
  private lastBytesAt = Date.now()
  private bytesPerSec = 0

  private writtenBytes = 0
  private lastSegmentAt = 0
  private bytesOnDisk = 0

  constructor(private readonly dir: string) {}

  get indexPath(): string {
    return join(this.dir, 'index.csv')
  }

  get nextSegmentNumber(): number {
    const last = this.segments.at(-1)
    return last ? last.index + 1 : 0
  }

  get newestEnd(): number {
    return this.segments.at(-1)?.end ?? 0
  }

  get oldestStart(): number {
    return this.segments[0]?.start ?? 0
  }

  /*
   * newestEnd only moves when a segment closes, so on its own it lags real time
   * by up to one segment. Anything that has to line up with the moment a key was
   * pressed needs this instead.
   */
  get liveEnd(): number {
    if (this.lastSegmentAt === 0) return this.newestEnd
    return (
      this.newestEnd + Math.min(SEGMENT_SEC, (Date.now() - this.lastSegmentAt) / 1000)
    )
  }

  beginRun(params: Omit<Run, 'id' | 'firstSegment' | 'lastSegment'>): void {
    const previous = this.runs.at(-1)
    if (previous) previous.lastSegment = this.nextSegmentNumber - 1
    this.runId += 1
    this.runs.push({
      id: this.runId,
      firstSegment: this.nextSegmentNumber,
      lastSegment: null,
      ...params
    })
    void this.persistRuns()
  }

  async poll(): Promise<Segment[]> {
    let handle
    try {
      handle = await open(this.indexPath, 'r')
    } catch {
      return []
    }

    try {
      const { size } = await handle.stat()
      if (size <= this.csvOffset) return []

      const length = size - this.csvOffset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, this.csvOffset)
      this.csvOffset = size

      const text = this.carry + buffer.toString('utf8')
      const lines = text.split('\n')
      this.carry = lines.pop() ?? ''

      const added: Segment[] = []
      for (const line of lines) {
        const segment = this.parse(line)
        if (segment) {
          this.segments.push(segment)
          added.push(segment)
          this.lastSegmentAt = Date.now()
        }
      }
      return added
    } finally {
      await handle.close()
    }
  }

  private parse(line: string): Segment | null {
    const [file, start, end] = line.trim().split(',')
    if (!file || start === undefined || end === undefined) return null
    const match = /seg_(\d+)\.ts$/.exec(file)
    if (!match?.[1]) return null
    return {
      index: Number(match[1]),
      file: join(this.dir, file),
      start: Number(start),
      end: Number(end),
      runId: this.runId,
      bytes: 0
    }
  }

  async measure(): Promise<void> {
    let total = 0
    for (const segment of this.segments) {
      if (segment.bytes === 0) {
        segment.bytes = await stat(segment.file)
          .then((s) => s.size)
          .catch(() => 0)

        this.writtenBytes += segment.bytes
      }
      total += segment.bytes
    }
    this.bytesOnDisk = total

    const now = Date.now()
    const elapsed = (now - this.lastBytesAt) / 1000
    if (elapsed < 2) return

    const rate = (this.writtenBytes - this.lastBytes) / elapsed

    this.bytesPerSec = this.bytesPerSec > 0 ? this.bytesPerSec * 0.6 + rate * 0.4 : rate
    this.lastBytes = this.writtenBytes
    this.lastBytesAt = now
  }

  pin(lo: number, hi: number | null, owner: string): void {
    this.pins.push({ lo, hi, owner, expiresAt: Date.now() + PIN_TTL_MS })
  }

  unpin(owner: string): void {
    this.pins = this.pins.filter((pin) => pin.owner !== owner)
  }

  private isPinned(index: number): boolean {
    const now = Date.now()
    this.pins = this.pins.filter((pin) => pin.expiresAt > now)
    return this.pins.some((pin) => index >= pin.lo && (pin.hi === null || index <= pin.hi))
  }

  async prune(keepSec: number): Promise<number> {
    const cutoff = this.newestEnd - (keepSec + SEGMENT_SEC * 2 + 10)
    if (cutoff <= 0) return 0

    const keep: Segment[] = []
    let removed = 0
    for (const segment of this.segments) {
      if (segment.end < cutoff && !this.isPinned(segment.index)) {
        await rm(segment.file, { force: true })
        removed += 1
      } else {
        keep.push(segment)
      }
    }
    this.segments = keep
    return removed
  }

  window(from: number, to: number): { segments: Segment[]; offsetIntoFirst: number } | null {
    const covering = this.segments.filter((s) => s.end > from && s.start < to)
    const first = covering[0]
    if (!first) return null
    return { segments: covering, offsetIntoFirst: Math.max(0, from - first.start) }
  }

  async stats(): Promise<RingStats> {
    const bytesOnDisk = this.bytesOnDisk
    const free = await statfs(this.dir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => 0)

    const inProgress = this.liveEnd - this.newestEnd

    return {
      segmentCount: this.segments.length,
      bufferedSec: this.newestEnd - this.oldestStart + inProgress,
      bytesOnDisk,
      bytesPerSec: this.bytesPerSec,
      freeDiskBytes: free
    }
  }

  compatibleFrom(segments: Segment[]): Segment[] {
    const last = segments.at(-1)
    if (!last) return segments
    const run = this.runs.find((r) => r.id === last.runId)
    if (!run) return segments

    const compatible = this.runs
      .filter(
        (r) =>
          r.width === run.width &&
          r.height === run.height &&
          r.fps === run.fps &&
          r.codec === run.codec
      )
      .map((r) => r.id)

    const out: Segment[] = []
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]
      if (!segment || !compatible.includes(segment.runId)) break
      out.unshift(segment)
    }
    return out
  }

  private async persistRuns(): Promise<void> {
    await writeFile(join(this.dir, 'runs.json'), JSON.stringify(this.runs, null, 2), 'utf8').catch(
      () => undefined
    )
  }

  async reset(): Promise<void> {
    this.segments = []
    this.runs = []
    this.pins = []
    this.csvOffset = 0
    this.carry = ''
    this.runId = 0
    this.writtenBytes = 0
    this.bytesOnDisk = 0
    this.lastBytes = 0
    this.bytesPerSec = 0
    this.lastSegmentAt = 0

    await unlinkPatiently(this.indexPath)
    await unlinkPatiently(join(this.dir, 'runs.json'))

    const stale = await readdir(this.dir).catch(() => [] as string[])
    for (const name of stale) {
      if (/^seg_\d+\.ts$/.test(name)) await unlinkPatiently(join(this.dir, name))
    }
  }
}

async function unlinkPatiently(path: string, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

export async function sweepOrphans(dir: string): Promise<{ files: number; bytes: number }> {
  const names = await readdir(dir).catch(() => [] as string[])
  let files = 0
  let bytes = 0

  for (const name of names) {
    if (!/^seg_\d+\.ts$/.test(name) && name !== 'index.csv' && name !== 'runs.json') continue
    const path = join(dir, name)
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0)
    await rm(path, { force: true }).catch(() => undefined)
    files += 1
    bytes += size
  }

  const work = join(dir, 'work')
  const stale = await readdir(work).catch(() => [] as string[])
  for (const name of stale) {
    const path = join(work, name)
    bytes += await stat(path)
      .then((s) => s.size)
      .catch(() => 0)
    await rm(path, { force: true }).catch(() => undefined)
    files += 1
  }

  return { files, bytes }
}
