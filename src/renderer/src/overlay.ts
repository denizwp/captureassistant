/**
 * Overlay badge logic. The only JS that runs here after first paint is this
 * one message handler — no timers, no rendering loop. The elapsed counter is
 * pushed from the main process at 1 Hz, and only while the window is visible.
 */
interface OverlayState {
  recording: boolean
  replayArmed: boolean
  micActive: boolean
  elapsedSec: number
  opacity: number
  corner: string
}

declare global {
  interface Window {
    overlay: { on(listener: (payload: unknown) => void): () => void }
  }
}

const rec = document.getElementById('rec')
const replay = document.getElementById('replay')
const mic = document.getElementById('mic')
const elapsed = document.getElementById('elapsed')

function formatClock(totalSec: number): string {
  const min = Math.floor(totalSec / 60)
  const sec = Math.floor(totalSec % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

window.overlay.on((payload) => {
  const state = payload as OverlayState
  rec?.classList.toggle('is-on', state.recording)
  replay?.classList.toggle('is-on', state.replayArmed)
  mic?.classList.toggle('is-on', state.micActive)
  if (elapsed) elapsed.textContent = formatClock(state.elapsedSec)
  document.body.style.opacity = String(state.opacity)
  document.body.dataset['corner'] = state.corner
})

export {}
