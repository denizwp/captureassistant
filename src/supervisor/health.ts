/*
 * ffmpeg pads the output to keep it CFR, so a clip can carry a perfect 60fps
 * header while the screen was only sampled a handful of times a second. The
 * duplicate counter from -progress is the only number that separates the two,
 * and reading that stream also keeps ffmpeg from blocking on a full pipe.
 */
interface Sample {
  at: number
  frames: number
  dups: number
  bytes: number
}

export class CaptureHealth {
  private carry = ''
  private frames = 0
  private dups = 0
  private bytes = 0
  private samples: { at: number; frames: number; dups: number; bytes: number }[] = []

  constructor(private readonly windowMs = 10_000) {}

  feed(chunk: string): void {
    const lines = (this.carry + chunk).split('\n')
    this.carry = lines.pop() ?? ''
    for (const line of lines) {
      const at = line.indexOf('=')
      if (at < 0) continue
      const key = line.slice(0, at).trim()
      const value = Number(line.slice(at + 1).trim())
      if (key === 'frame' && Number.isFinite(value)) this.frames = value
      else if (key === 'dup_frames' && Number.isFinite(value)) this.dups = value
      else if (key === 'total_size' && Number.isFinite(value)) this.bytes = value
      else if (key === 'progress') this.mark()
    }
  }

  private mark(): void {
    const now = Date.now()
    this.samples.push({ at: now, frames: this.frames, dups: this.dups, bytes: this.bytes })
    while (this.samples.length > 2 && now - (this.samples[0]?.at ?? now) > this.windowMs) this.samples.shift()
  }

  private get span(): { first: Sample; last: Sample; seconds: number } | null {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (!first || !last) return null
    const seconds = (last.at - first.at) / 1000
    if (seconds < this.windowMs / 1000 - 1) return null
    return { first, last, seconds }
  }

  /* Frames that actually came off the screen, per second. Null until the window has filled. */
  get effectiveFps(): number | null {
    const span = this.span
    if (!span) return null
    const fresh = span.last.frames - span.first.frames - (span.last.dups - span.first.dups)
    return Math.max(0, fresh / span.seconds)
  }

  /*
   * A screen nobody is touching also produces almost no fresh frames, so a low
   * rate on its own says nothing. What separates the two is how much the
   * encoder had to write: a stalled game capture still carries real detail
   * between the frames it does get, while a still desktop compresses to
   * nothing.
   */
  get kbps(): number | null {
    const span = this.span
    if (!span) return null
    return Math.max(0, ((span.last.bytes - span.first.bytes) * 8) / span.seconds / 1000)
  }
}
