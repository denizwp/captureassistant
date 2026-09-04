import type { ChatKind } from '@shared/chat'

/* Servers put the in-game clock at the front of a line when they set one. */
const TIMESTAMP = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*/

const PRIVATE = /^\(\(\s*(?:PM|ÖM)\s|^\/pm\b|^\(\(\s*\w+\s+says\s*\(PM\)/i
const OOC_COMMAND = /^\/b(?:\s|$)/i

export interface Split {
  /* Whatever the server stamped, or null when it stamped nothing. */
  stamp: { hour: number; minute: number; second: number } | null
  /* The line with that stamp taken off the front. */
  body: string
  /* How many characters were removed, so colour runs can be shifted to match. */
  removed: number
}

export function splitTimestamp(line: string): Split {
  const match = TIMESTAMP.exec(line)
  if (!match) return { stamp: null, body: line, removed: 0 }
  return {
    stamp: {
      hour: Number(match[1]),
      minute: Number(match[2]),
      second: Number(match[3] ?? '0')
    },
    body: line.slice(match[0].length),
    removed: match[0].length
  }
}

/*
 * Turns the server's clock into a real moment. The stamp has no date on it, so
 * it is read against the moment the line was seen; a stamp that lands more than
 * a couple of hours in the future belongs to the day before, which is what a
 * line captured just after midnight looks like.
 */
export function resolveMoment(seenAt: number, stamp: Split['stamp']): number {
  if (!stamp) return seenAt
  const seen = new Date(seenAt)
  const candidate = new Date(
    seen.getFullYear(),
    seen.getMonth(),
    seen.getDate(),
    stamp.hour,
    stamp.minute,
    stamp.second
  ).getTime()
  if (!Number.isFinite(candidate)) return seenAt
  if (candidate - seenAt > 2 * 60 * 60 * 1000) return candidate - 24 * 60 * 60 * 1000
  return candidate
}

/*
 * Roleplay servers do not tag their lines, so this reads the shape players
 * already recognise: /me and /do arrive starting with * or >, anything in
 * double parentheses or behind /b is out of character, and the server talks to
 * you in square brackets.
 */
export function classify(body: string): ChatKind {
  const text = body.trim()
  if (!text) return 'info'
  if (PRIVATE.test(text)) return 'pm'
  if (text.startsWith('((') || OOC_COMMAND.test(text)) return 'ooc'
  if (/^\[[A-Za-zÇĞİÖŞÜçğıöşü ]+\]/.test(text)) return 'info'
  if (text.startsWith('*') || text.startsWith('>')) return 'ic'
  return 'ic'
}
