export function formatDuration(totalSec: number): string {
  const min = Math.floor(totalSec / 60)
  const sec = Math.floor(totalSec % 60)
  return `${min}:${String(sec).padStart(2, '0')}`
}

export function formatClock(totalSec: number): string {
  const hours = Math.floor(totalSec / 3600)
  const rest = formatDuration(totalSec % 3600)
  return hours > 0 ? `${hours}:${rest.padStart(5, '0')}` : rest
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent

  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${UNITS[exponent]}`
}

export function estimateRingBytes(durationSec: number, maxrateKbps: number): number {
  const audioKbps = 512
  const containerOverhead = 1.02
  return ((maxrateKbps + audioKbps) * 1000 * durationSec * containerOverhead) / 8
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('tr-TR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}
