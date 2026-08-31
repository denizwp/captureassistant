import { useEffect, useState } from 'react'
import type { Clip } from '@shared/state'
import { api } from '../api'
import { formatBytes, formatClock, formatDate } from '../format'
import art from '../../assets/character-panel.png'

export function ClipsScreen() {
  const [clips, setClips] = useState<Clip[]>([])

  useEffect(() => api.on('clips', (payload) => setClips(payload as Clip[])), [])

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Kayıtlar</span>
          <span className="badge badge--muted">{clips.length} klip</span>
        </div>
        <div className="pane__body">
          {clips.length === 0 ? (
            <div className="empty">
              <p className="empty__title">Henüz klip yok</p>
              <p className="empty__hint">
                Geçmiş kaydı açtığında son dakikalar arka planda tutulur. Kısayola bastığın anda
                geçmiş süre buraya bir klip olarak düşer.
              </p>
            </div>
          ) : (
            <div className="gallery">
              {clips.map((clip) => (
                <button type="button" className="clip" key={clip.id}>
                  <span className="clip__thumb">
                    {clip.thumbnailPath ? <img src={clip.thumbnailPath} alt="" /> : null}
                    <span className="clip__duration">{formatClock(clip.durationSec)}</span>
                  </span>
                  <span className="clip__name">{clip.name}</span>
                  <span className="clip__meta">
                    {formatDate(clip.createdAt)} · {formatBytes(clip.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
