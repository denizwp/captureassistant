import { useCallback, useEffect, useState } from 'react'
import type { DeepPartial } from '@shared/ipc'
import type { HotkeySettings, Settings } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { Keys, Section } from '../components/controls'
import art from '../../assets/character-panel.png'

const BINDINGS: { key: keyof HotkeySettings; label: string; hint?: string }[] = [
  { key: 'saveReplay', label: 'Geçmiş kaydı kaydet' },
  { key: 'toggleRecord', label: 'Manuel kaydı başlat / durdur' },
  { key: 'toggleReplayBuffer', label: 'Geçmiş kaydı aç / kapa' },
  { key: 'toggleMic', label: 'Mikrofonu aç / kapa' },
  { key: 'toggleIndicators', label: 'Göstergeleri göster / gizle' }
]

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

function toAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')

  const key = event.key
  const named =
    key.length === 1
      ? key.toUpperCase()
      : key === ' '
        ? 'Space'
        : key === 'ArrowUp'
          ? 'Up'
          : key === 'ArrowDown'
            ? 'Down'
            : key === 'ArrowLeft'
              ? 'Left'
              : key === 'ArrowRight'
                ? 'Right'
                : key

  parts.push(named)

  const isFunctionKey = /^F\d{1,2}$/.test(named)
  if (parts.length === 1 && !isFunctionKey) return null

  return parts.join('+')
}

export function HotkeysScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const [listening, setListening] = useState<keyof HotkeySettings | null>(null)

  const stop = useCallback(() => setListening(null), [])

  useEffect(() => {
    if (!listening) return

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        stop()
        return
      }

      const accelerator = toAccelerator(event)
      if (!accelerator) return

      patch({ hotkeys: { [listening]: accelerator } as Partial<HotkeySettings> })
      stop()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [listening, patch, stop])

  const isDefault = (Object.keys(DEFAULT_SETTINGS.hotkeys) as (keyof HotkeySettings)[]).every(
    (key) => settings.hotkeys[key] === DEFAULT_SETTINGS.hotkeys[key]
  )

  const counts = new Map<string, number>()
  for (const combo of Object.values(settings.hotkeys)) {
    counts.set(combo, (counts.get(combo) ?? 0) + 1)
  }

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Kısayollar</span>
          {listening ? (
            <span className="badge badge--muted">
              <span className="badge__dot badge__dot--success" />
              Tuş bekleniyor — çıkmak için Esc
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={isDefault}
              onClick={() => patch({ hotkeys: DEFAULT_SETTINGS.hotkeys })}
            >
              <i className="ph ph-arrow-counter-clockwise" />
              Varsayılana dön
            </button>
          )}
        </div>
        <div className="pane__body">
          <Section title="Bağlar">
            {BINDINGS.map((binding) => {
              const combo = settings.hotkeys[binding.key]
              const isListening = listening === binding.key
              const conflicted = (counts.get(combo) ?? 0) > 1
              return (
                <div className="setting" key={binding.key}>
                  <div className="setting__text">
                    <span className="label">{binding.label}</span>
                    {conflicted ? (
                      <span className="field__error">
                        Bu kombinasyon başka bir kısayolla çakışıyor.
                      </span>
                    ) : binding.hint ? (
                      <span className="setting__hint">{binding.hint}</span>
                    ) : null}
                  </div>
                  <div className="setting__control">
                    <button
                      type="button"
                      className={`hotkey${isListening ? ' is-listening' : ''}${
                        conflicted ? ' is-conflict' : ''
                      }`}
                      onClick={() => setListening(isListening ? null : binding.key)}
                    >
                      {isListening ? 'Bir tuşa bas…' : <Keys combo={combo} />}
                    </button>
                  </div>
                </div>
              )
            })}
            <p className="section__note">
              Kısayollar oyun tam ekrandayken de çalışır. Oyun yönetici olarak çalışıyorsa
              Capture Assistant&apos;ın da yönetici olarak açılması gerekir.
            </p>
          </Section>
        </div>
      </div>
    </main>
  )
}
