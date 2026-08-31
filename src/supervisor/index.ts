/**
 * Capture supervisor — runs as an Electron utilityProcess.
 *
 * Owns the ffmpeg ring encoder, the segment index, the janitor, the disk guard
 * and the clip assembler. It lives out of the main process so a leak or crash
 * in the segment/assembly logic cannot take down the tray, the hotkeys, or the
 * sibling processes of an in-flight recording.
 *
 * Wired up in a later step; this entry exists so the build graph is complete.
 */
import { INITIAL_STATE, type SupervisorState } from '@shared/state'

let state: SupervisorState = INITIAL_STATE

process.parentPort?.on('message', (e) => {
  const message = e.data as { type: string }
  if (message.type === 'state:request') push()
})

function push(): void {
  process.parentPort?.postMessage({ type: 'state', state })
}

// Keep the reference alive for the linter until the state machine lands.
export function setState(next: SupervisorState): void {
  state = next
  push()
}
