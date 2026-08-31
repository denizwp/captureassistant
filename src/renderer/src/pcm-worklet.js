/**
 * Interleaves the four input channels (system L/R, mic L/R) into one f32
 * stream and posts it out in fixed blocks.
 *
 * Plain JS on purpose: this file is loaded by `audioWorklet.addModule()` as a
 * module URL, so it has to be something the browser can parse directly.
 *
 * Runs on the realtime audio thread. The only allocation is one block buffer
 * per ~20 ms, which replaces the one just transferred away — small enough for
 * the young generation, and unavoidable without SharedArrayBuffer (which needs
 * cross-origin isolation we cannot get on file://).
 */

const CHANNELS = 4
const BLOCK_FRAMES = 960 // 20 ms at 48 kHz

class PcmPump extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(BLOCK_FRAMES * CHANNELS)
    this.frame = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const first = input[0]
    const frames = first ? first.length : 0

    for (let i = 0; i < frames; i++) {
      const base = this.frame * CHANNELS
      for (let c = 0; c < CHANNELS; c++) {
        const channel = input[c]
        // A muted or absent source contributes silence rather than dropping
        // the frame — the stream must stay continuous or audio drifts against
        // video for the rest of the recording.
        this.block[base + c] = channel ? channel[i] : 0
      }

      if (++this.frame === BLOCK_FRAMES) {
        this.port.postMessage(this.block, [this.block.buffer])
        this.block = new Float32Array(BLOCK_FRAMES * CHANNELS)
        this.frame = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-pump', PcmPump)
