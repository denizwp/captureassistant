/*
 * What a captured chat line looks like once it has left the game.
 *
 * The colours are kept as runs over the text rather than as marked-up text: a
 * run is a stretch of characters that shared one colour on screen. That keeps
 * the line usable as plain text — which is what the archive on disk holds — and
 * still lets the app draw it the way the server drew it.
 */
export interface ChatColorRun {
  start: number
  length: number
  /* #rrggbb */
  color: string
}

/*
 * ic     what a character said or did
 * ooc    out of character, either (( )) or /b
 * pm     a private message either way
 * info   the server talking to you specifically
 * system this app's own markers: login, disconnect, day rollover
 */
export type ChatKind = 'ic' | 'ooc' | 'pm' | 'info' | 'system'

export interface ChatLine {
  id: string
  /* Milliseconds. The server's own timestamp when the line carried one. */
  at: number
  /* The line without the leading [HH:MM:SS], which is shown separately. */
  text: string
  kind: ChatKind
  runs: ChatColorRun[]
}

export type ChatState = 'off' | 'waiting' | 'connected' | 'error'

export interface ChatStatus {
  state: ChatState
  serverName: string | null
  serverAddress: string | null
  /* The file today's lines are being appended to. */
  archiveFile: string | null
  capturedToday: number
  error: string | null
}

export const INITIAL_CHAT_STATUS: ChatStatus = {
  state: 'off',
  serverName: null,
  serverAddress: null,
  archiveFile: null,
  capturedToday: 0,
  error: null
}

/* Used for the parts of a line the game did not colour itself. */
export const KIND_COLORS: Record<ChatKind, string> = {
  ic: '#e6e9ef',
  ooc: '#9aa4b2',
  pm: '#f2dd63',
  info: '#7fc8a9',
  system: '#6b7280'
}

export const KIND_LABELS: Record<ChatKind, string> = {
  ic: 'Rol',
  ooc: 'OOC',
  pm: 'Özel',
  info: 'Sunucu',
  system: 'İşaret'
}

/*
 * Splits a line into coloured pieces. The runs cover only what the game
 * actually painted, so any gap between them falls back to the colour for that
 * kind of line rather than losing the text.
 */
export function spansFor(
  text: string,
  runs: ChatColorRun[],
  kind: ChatKind
): { text: string; color: string }[] {
  const fallback = KIND_COLORS[kind]
  if (runs.length === 0) return [{ text, color: fallback }]

  const ordered = [...runs].sort((a, b) => a.start - b.start)
  const spans: { text: string; color: string }[] = []
  let at = 0
  for (const run of ordered) {
    if (run.start > at) spans.push({ text: text.slice(at, run.start), color: fallback })
    const end = Math.min(text.length, run.start + run.length)
    if (end > run.start) spans.push({ text: text.slice(run.start, end), color: run.color })
    at = Math.max(at, end)
  }
  if (at < text.length) spans.push({ text: text.slice(at), color: fallback })
  return spans.filter((span) => span.text.length > 0)
}

export interface ArchiveEntry {
  path: string
  /* "Sunucu Adı" as it was when the file was written. */
  server: string
  /* Local midnight of the day the file covers. */
  day: number
  sizeBytes: number
  lines: number
}
