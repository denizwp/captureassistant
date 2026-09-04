import { useEffect, useState } from 'react'
import type { SupervisorState } from '@shared/state'
import { INITIAL_STATE } from '@shared/state'
import { api } from './api'
import { useSettings } from './useSettings'
import { useBusy } from './useBusy'
import { formatBytes, formatClock } from './format'
import { ClipsScreen } from './screens/Clips'
import { RecordingScreen } from './screens/Recording'
import { GeneralScreen } from './screens/General'
import { ChatScreen } from './screens/Chat'
import { QuickActions } from './components/QuickActions'
import { Toasts } from './components/Toasts'
import logo from '../assets/logo.png'

/*
 * Four entries rather than six. Sound is part of what the capture is set up to
 * do, and the key bindings are a settings list like any other — keeping them
 * apart only made the list longer to read through.
 */
const SCREENS = [
  { id: 'clips', label: 'Kayıtlar', icon: 'ph-film-strip' },
  { id: 'recording', label: 'Kayıt ve ses', icon: 'ph-record' },
  { id: 'chat', label: 'Chatlog', icon: 'ph-chat-text' },
  { id: 'general', label: 'Ayarlar', icon: 'ph-gear' }
] as const

type ScreenId = (typeof SCREENS)[number]['id']

export function App() {
  const { settings, patch } = useSettings()
  const [screen, setScreen] = useState<ScreenId>('clips')
  const [state, setState] = useState<SupervisorState>(INITIAL_STATE)
  const busy = useBusy()

  useEffect(() => {
    void api.getState().then((s) => setState(s as SupervisorState))
    return api.on('state', (payload) => setState(payload as SupervisorState))
  }, [])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset['mode'] = settings.app.theme
    document.documentElement.dataset['art'] = settings.app.showCharacterArt ? 'on' : 'off'
  }, [settings])

  if (!settings) return null

  return (
    <>
      <header className="appbar">
        <Brand />
        <div className="appbar__meta">
          <StateBadge state={state} />
          <div className="wincontrols">
            <button type="button" aria-label="Simge durumuna küçült" onClick={api.windowMinimize}>
              <i className="ph ph-minus" />
            </button>
            <button type="button" className="is-close" aria-label="Kapat" onClick={api.windowClose}>
              <i className="ph ph-x" />
            </button>
          </div>
        </div>
      </header>

      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar__scroll">
            <div className="sidebar__group sidebar__group--actions">
              <QuickActions settings={settings} state={state} busy={busy} />
            </div>

            <div className="sidebar__group">
              <nav className="nav">
                {SCREENS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nav__item${item.id === screen ? ' is-active' : ''}`}
                    onClick={() => setScreen(item.id)}
                  >
                    <i className={`ph ${item.icon}`} />
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>

            <div className="sidebar__group">
              <h2 className="sidebar__group-label">Durum</h2>
              <div className="status-list">
                <StatusRow
                  label="Geçmiş kayıt"
                  value={state.state === 'idle' ? 'Kapalı' : 'Açık'}
                  tone={state.state === 'idle' ? 'neutral' : 'success'}
                />
                <StatusRow
                  label="Encoder"
                  value={state.encoder?.id ?? 'Belirlenmedi'}
                  tone={state.encoder?.hardware ? 'success' : 'neutral'}
                />
                <StatusRow
                  label="Tampon"
                  value={
                    state.ring ? formatClock(state.ring.bufferedSec) : '—'
                  }
                  tone="neutral"
                />
              </div>
            </div>
          </div>

          <dl className="sidebar__footer">
            <div className="meta-row">
              <dt>Tampon boyutu</dt>
              <dd className="mono">{state.ring ? formatBytes(state.ring.bytesOnDisk) : '—'}</dd>
            </div>
            <div className="meta-row">
              <dt>Yazma hızı</dt>
              <dd className="mono">
                {state.ring ? `${formatBytes(state.ring.bytesPerSec * 3600)}/sa` : '—'}
              </dd>
            </div>
          </dl>
        </aside>

        {screen === 'clips' && <ClipsScreen />}
        {screen === 'recording' && (
          <RecordingScreen settings={settings} state={state} patch={patch} busy={busy} />
        )}
        {screen === 'chat' && <ChatScreen settings={settings} patch={patch} />}
        {screen === 'general' && <GeneralScreen settings={settings} patch={patch} />}
      </div>

      <Toasts />
    </>
  )
}

function Brand() {
  return (
    <div className="brand">
      <img className="brand__mark" src={logo} alt="" aria-hidden="true" />
      <span className="brand__word">
        Capture <em>Assistant</em>
      </span>
      {}
      <a
        className="brand__by"
        href="https://deniz.cyou/"
        target="_blank"
        rel="noreferrer"
        title="deniz.cyou"
      >
        deniz.cyou
      </a>
    </div>
  )
}

function StateBadge({ state }: { state: SupervisorState }) {
  if (state.lastError) {
    return (
      <span className="badge badge--error" title={state.lastError}>
        <span className="badge__dot badge__dot--danger" />
        {state.lastError}
      </span>
    )
  }

  const map = {
    idle: { text: 'Boşta', dot: 'neutral' },
    armed: { text: 'Tampon açık', dot: 'success' },
    recording: { text: 'Kaydediyor', dot: 'success' },
    assembling: { text: 'Klip hazırlanıyor', dot: 'success' }
  } as const
  const current = map[state.state]

  return (
    <span className="badge badge--muted">
      <span className={`badge__dot badge__dot--${current.dot}`} />
      {current.text}
      {state.state === 'recording' && (
        <span className="mono">{formatClock(state.recordingElapsedSec)}</span>
      )}
    </span>
  )
}

function StatusRow({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'success' | 'neutral'
}) {
  return (
    <div className="status-row">
      <span className="status-row__label">{label}</span>
      <span className="badge badge--muted">
        <span className={`badge__dot badge__dot--${tone}`} />
        {value}
      </span>
    </div>
  )
}
