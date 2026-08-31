import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings } from '@shared/settings'
import type { Clip, SupervisorState } from '@shared/state'
import { INITIAL_STATE } from '@shared/state'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@phosphor-icons/web/regular'
import '@phosphor-icons/web/fill'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/hud.css'

import { formatBytes, formatClock, formatDuration } from './format'
import { Keys } from './components/controls'

interface HudApi {
  getSettings(): Promise<Settings>
  getState(): Promise<SupervisorState>
  listClips(): Promise<Clip[]>
  clipMeta(path: string, mtimeMs: number): Promise<{ thumbnail: string | null; durationSec: number }>
  openClip(path: string): Promise<void>
  toggleReplayBuffer(enabled: boolean): Promise<void>
  toggleRecording(): Promise<void>
  saveReplay(): Promise<void>
  toggleMic(): Promise<void>
  openSettings(): void
  close(): void
  on(channel: string, listener: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    hud: HudApi
  }
}

const api = window.hud

function Hud() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [state, setState] = useState<SupervisorState>(INITIAL_STATE)
  const [clips, setClips] = useState<Clip[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    api.getSettings().then(setSettings, () => setTimeout(refresh, 250))
    void api.getState().then(setState, () => undefined)
    void api.listClips().then((list) => setClips(list.slice(0, 3)), () => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const offState = api.on('state', (p) => setState(p as SupervisorState))
    const offSettings = api.on('settings', (p) => setSettings(p as Settings))
    const offClips = api.on('clips', (p) => setClips((p as Clip[]).slice(0, 3)))

    const onShow = (): void => refresh()
    window.addEventListener('focus', onShow)
    return () => {
      offState()
      offSettings()
      offClips()
      window.removeEventListener('focus', onShow)
    }
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    for (const clip of clips) {
      if (thumbs[clip.id]) continue
      void api.clipMeta(clip.path, clip.createdAt).then((meta) => {
        if (!cancelled && meta.thumbnail) {
          setThumbs((current) => ({ ...current, [clip.id]: meta.thumbnail as string }))
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [clips, thumbs])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') api.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (settings) document.documentElement.dataset['mode'] = settings.app.theme
  }, [settings])

  if (!settings) return null

  const armed = state.state !== 'idle'
  const recording = state.state === 'recording'
  const busy = state.state === 'assembling'

  return (
    <div className="hud">
      <header className="hud__head">
        <span className="hud__title">Capture Assistant</span>
        <span className="hud__state">
          <span className={`badge__dot badge__dot--${armed ? 'success' : 'neutral'}`} />
          {recording
            ? `Kaydediyor ${formatClock(state.recordingElapsedSec)}`
            : busy
              ? 'Klip hazırlanıyor'
              : armed
                ? 'Tampon açık'
                : 'Boşta'}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => api.close()}>
          <i className="ph ph-x" />
        </button>
      </header>

      <div className="hud__actions">
        <button
          type="button"
          className={`btn btn--lg btn--emphasis hud__primary ${
            recording ? 'btn--destructive' : 'btn--primary'
          }`}
          disabled={busy}
          onClick={() => void api.toggleRecording()}
        >
          <span className="btn__fill" />
          <span className="btn__label">
            <i className={`ph-fill ${recording ? 'ph-stop-circle' : 'ph-record'}`} />
            {recording ? 'Kaydı durdur' : 'Kaydı başlat'}
          </span>
          <span className="btn__hint">
            <Keys combo={settings.hotkeys.toggleRecord} />
          </span>
        </button>

        <button
          type="button"
          className="btn btn--lg btn--secondary hud__primary"
          disabled={state.state !== 'armed'}
          onClick={() => void api.saveReplay()}
        >
          <span className="btn__label">
            <i className="ph ph-clock-counter-clockwise" />
            Son {formatDuration(settings.replay.durationSec)}
          </span>
          <span className="btn__hint">
            <Keys combo={settings.hotkeys.saveReplay} />
          </span>
        </button>
      </div>

      <div className="hud__toggles">
        <button
          type="button"
          className={`hud__toggle${armed ? ' is-on' : ''}`}
          disabled={busy}
          onClick={() => void api.toggleReplayBuffer(!armed)}
        >
          <i className="ph ph-clock-counter-clockwise" />
          <span>Geçmiş kayıt</span>
          <Keys combo={settings.hotkeys.toggleReplayBuffer} />
        </button>

        <button
          type="button"
          className={`hud__toggle${settings.audio.micEnabled ? ' is-on' : ''}`}
          onClick={() => void api.toggleMic()}
        >
          <i
            className={`ph ${settings.audio.micEnabled ? 'ph-microphone' : 'ph-microphone-slash'}`}
          />
          <span>Mikrofon</span>
          <Keys combo={settings.hotkeys.toggleMic} />
        </button>

        <button type="button" className="hud__toggle" onClick={() => api.openSettings()}>
          <i className="ph ph-gear" />
          <span>Ayarlar</span>
        </button>
      </div>

      <section className="hud__clips">
        <h2 className="hud__section">Son klipler</h2>
        {clips.length === 0 ? (
          <p className="hud__empty">Henüz klip yok.</p>
        ) : (
          <div className="hud__grid">
            {clips.map((clip) => (
              <button
                type="button"
                key={clip.id}
                className="clip"
                onClick={() => void api.openClip(clip.path)}
              >
                <span className="clip__thumb">
                  {thumbs[clip.id] ? (
                    <img src={thumbs[clip.id]} alt="" />
                  ) : (
                    <i className="ph ph-film-slate clip__placeholder" />
                  )}
                </span>
                <span className="clip__name">{clip.name}</span>
                <span className="clip__meta">{formatBytes(clip.sizeBytes)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <footer className="hud__foot">
        <span>
          Kapatmak için <span className="kbd">Esc</span> ya da{' '}
          <Keys combo={settings.hotkeys.toggleHud} />
        </span>
        {state.ring ? <span className="mono">{formatBytes(state.ring.bytesOnDisk)}</span> : null}
      </footer>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')

createRoot(container).render(
  <StrictMode>
    <Hud />
  </StrictMode>
)
