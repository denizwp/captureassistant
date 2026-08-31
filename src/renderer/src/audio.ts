/**
 * Audio pump.
 *
 * FFmpeg has no WASAPI loopback input device on Windows, and the DirectShow
 * virtual-device route needs a driver install we do not want to inflict on
 * users. Chromium can do loopback capture, but only from a renderer — hence
 * this hidden page.
 *
 * Both sources feed one AudioContext and one worklet, so system audio and mic
 * are sampled off the same clock and cannot drift apart from each other by
 * construction. The four channels go out as one interleaved f32le stream and
 * are split again inside the ffmpeg filter graph.
 *
 * Wired up in a later step; the page and its bridge exist so the build graph
 * and the window plumbing can be finished first.
 */
declare global {
  interface Window {
    audioBridge: {
      writePcm(buffer: ArrayBuffer): void
      ready(): void
      on(listener: (payload: unknown) => void): () => void
    }
  }
}

window.audioBridge.ready()

export {}
