import { screen } from 'electron'

/*
 * Chromium reports the desktop colour space per display, so HDR needs no
 * native call: an HDR desktop comes back as PQ or scRGB linear instead of
 * plain sRGB.
 */
const HDR_TRANSFER = /transfer:(PQ|HLG|SCRGB_LINEAR|LINEAR_HDR)/i

let warned = false

export function hdrDisplayCount(): number {
  return screen.getAllDisplays().filter((d) => HDR_TRANSFER.test(d.colorSpace ?? '')).length
}

export function warnIfHdr(notify: (message: string) => void): void {
  if (hdrDisplayCount() === 0) {
    warned = false
    return
  }
  if (warned) return

  warned = true
  notify(
    'Bu ekranda HDR açık. Klipler SDR olarak kaydedilir, renkler soluk çıkabilir. ' +
      'En doğru sonuç için Windows HDR ayarını kapat.'
  )
}
