const CHANNELS = 4
const BLOCK_FRAMES = 960

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
