import type { Settings } from '@shared/settings'
import type { SupervisorState } from '@shared/state'
import { api } from '../api'
import { formatDuration } from '../format'
import { Keys } from './controls'

export function QuickActions({
  settings,
  state
}: {
  settings: Settings
  state: SupervisorState
}) {
  const recording = state.state === 'recording'
  const armed = state.state !== 'idle'
  const busy = state.state === 'assembling'

  return (
    <div className="actions">
      <button
        type="button"
        className={`btn btn--block btn--action btn--emphasis ${
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
        className="btn btn--block btn--action btn--secondary"

        disabled={state.state !== 'armed'}
        title={
          armed
            ? `Son ${formatDuration(settings.replay.durationSec)} kadarını klip olarak kaydet`
            : 'Önce geçmiş kaydı aç — kaydedilecek bir tampon yok.'
        }
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

      <div className="action-row">
        <span className="action-row__label">Geçmiş kayıt</span>
        <span className="action-row__keys">
          <Keys combo={settings.hotkeys.toggleReplayBuffer} />
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={armed}
          aria-label="Geçmiş kaydı aç"
          className="switch"
          onClick={() => void api.toggleReplayBuffer(!armed)}
        />
      </div>
    </div>
  )
}
