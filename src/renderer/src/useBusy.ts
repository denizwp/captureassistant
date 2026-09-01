import { useEffect, useState } from 'react'
import { api } from './api'

/*
 * Arming, recording and building a clip all take long enough for someone to
 * press the button again. Main drops the extra presses; this is how the window
 * shows that it did.
 */
export function useBusy(): boolean {
  const [busy, setBusy] = useState(false)
  useEffect(() => api.on('busy', (payload) => setBusy(payload !== null)), [])
  return busy
}
