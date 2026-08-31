/*
 * ffmpeg pads the output to keep it CFR, so a clip can carry a perfect 60fps
 * header while the screen was only sampled a handful of times a second. The
 * duplicate counter from -progress is the only number that separates the two,
 * and reading that stream also keeps ffmpeg from blocking on a full pipe.
 */
export class CaptureHealth {
  private carry = ''
  private frames = 0
  private dups = 0
  private samples: { at: number; frames: number; dups: number }[] = []

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
      else if (key === 'progress') this.mark()
    }
  }

  private mark(): void {
    const now = Date.now()
    this.samples.push({ at: now, frames: this.frames, dups: this.dups })
    while (this.samples.length > 2 && now - (this.samples[0]?.at ?? now) > this.windowMs) this.samples.shift()
  }

  /* Frames that actually came off the screen, per second. Null until the window has filled. */
  get effectiveFps(): number | null {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (!first || !last) return null
    const seconds = (last.at - first.at) / 1000
    if (seconds < this.windowMs / 1000 - 1) return null
    const fresh = last.frames - first.frames - (last.dups - first.dups)
    return Math.max(0, fresh / seconds)
  }
}
