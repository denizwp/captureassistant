import { open, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SEGMENT_SEC } from './pipeline'

export interface Segment {
  index: number
  file: string
  /** Absolute seconds on the ring timeline; continuous across the whole run
   *  because the muxer runs with `-reset_timestamps 0`. */
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

/** A range of segments the janitor must not touch. */
interface Pin {
  lo: number
  /** null means "up to whatever is newest" — an in-progress manual recording. */
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

/**
 * The on-disk ring.
 *
 * Everything is driven off the `index.csv` the segment muxer writes — one
 * `file,start,end` line per *closed* segment. Reading that is exact and costs
 * nothing; the alternative, `readdir` plus `ffprobe` per file, would be
 * hundreds of stat calls a second for information we are already being told.
 */
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

  constructor(private readonly dir: string) {}

  get indexPath(): string {
    return join(this.dir, 'index.csv')
  }

  /** Next value for `-segment_start_number`, so numbering survives a respawn
   *  and the janitor's view of the ring stays contiguous. */
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

  /**
   * Reads whatever the muxer has appended since last time.
   *
   * A partial trailing line is normal — the muxer may be mid-write — so it is
   * carried over rather than parsed.
   */
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

  /** Sizes are read lazily so the hot path stays free of stat calls. */
  async measure(): Promise<void> {
    let total = 0
    for (const segment of this.segments) {
      if (segment.bytes === 0) {
        segment.bytes = await stat(segment.file)
          .then((s) => s.size)
          .catch(() => 0)
      }
      total += segment.bytes
    }

    const now = Date.now()
    const elapsed = (now - this.lastBytesAt) / 1000
    if (elapsed >= 1 && this.lastBytes > 0) {
      // Only counts growth, so pruning does not read as a negative write rate.
      this.bytesPerSec = Math.max(0, (total - this.lastBytes) / elapsed)
    }
    if (elapsed >= 1) {
      this.lastBytes = total
      this.lastBytesAt = now
    }
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

  /**
   * Drops segments that have aged out of the window the user asked for.
   *
   * The keep window is deliberately generous: the requested duration, plus the
   * post-roll, plus two segments of slack so a hotkey pressed at the very edge
   * of the buffer still finds its oldest segment on disk.
   */
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

  /** Segments covering [from, to], plus where inside the first one to start. */
  window(from: number, to: number): { segments: Segment[]; offsetIntoFirst: number } | null {
    const covering = this.segments.filter((s) => s.end > from && s.start < to)
    const first = covering[0]
    if (!first) return null
    return { segments: covering, offsetIntoFirst: Math.max(0, from - first.start) }
  }

  async stats(): Promise<RingStats> {
    const bytesOnDisk = this.segments.reduce((sum, s) => sum + s.bytes, 0)
    const free = await statfs(this.dir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => 0)
    return {
      segmentCount: this.segments.length,
      bufferedSec: this.newestEnd - this.oldestStart,
      bytesOnDisk,
      bytesPerSec: this.bytesPerSec,
      freeDiskBytes: free
    }
  }

  /**
   * Runs with different parameters cannot be byte-concatenated — a resolution
   * change mid-buffer would produce a clip most players choke on. Recording
   * them lets the assembler trim to the newest compatible run and say so,
   * rather than emitting something silently broken.
   */
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

    // Walk back from the newest until a run that cannot be joined.
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

  /** Clears a stale ring left behind by a crash. Segments from a previous
   *  process are unusable: we have no index for them and their timeline does
   *  not line up with the run we are about to start. */
  async reset(): Promise<void> {
    this.segments = []
    this.runs = []
    this.pins = []
    this.csvOffset = 0
    this.carry = ''
    this.runId = 0
    await rm(this.indexPath, { force: true })
    const stale = await readFile(join(this.dir, 'runs.json'), 'utf8').catch(() => null)
    if (stale !== null) await rm(join(this.dir, 'runs.json'), { force: true })
  }
}
