import { useCallback, useEffect, useState } from 'react'
import type { Clip } from '@shared/state'
import { api } from '../api'
import { formatBytes, formatDate } from '../format'
import art from '../../assets/character-panel.png'

export function ClipsScreen() {
  const [clips, setClips] = useState<Clip[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    void api.listClips().then(setClips)
  }, [])

  useEffect(() => {
    refresh()
    return api.on('clips', (payload) => setClips(payload as Clip[]))
  }, [refresh])

  // Fetched after the list renders so the gallery never waits on ffmpeg.
  useEffect(() => {
    let cancelled = false
    for (const clip of clips) {
      if (thumbs[clip.id]) continue
      void api.clipThumbnail(clip.path, clip.createdAt).then((url) => {
        if (!cancelled && url) setThumbs((current) => ({ ...current, [clip.id]: url }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [clips, thumbs])

  const active = clips.find((clip) => clip.id === selected) ?? null

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Kayıtlar</span>
          <div className="setting__control">
            {active ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void api.openClip(active.path)}
                >
                  <i className="ph ph-play" />
                  Oynat
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void api.revealClip(active.path)}
                >
                  <i className="ph ph-folder-open" />
                  Klasörde göster
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    void api.deleteClip(active.path).then(() => setSelected(null))
                  }}
                >
                  <i className="ph ph-trash" />
                  Sil
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void api.revealClipFolder()}
              >
                <i className="ph ph-folder-open" />
                Klasörü aç
              </button>
            )}
            <span className="badge badge--muted">{clips.length} klip</span>
          </div>
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
                <button
                  type="button"
                  key={clip.id}
                  className={`clip${clip.id === selected ? ' is-selected' : ''}`}
                  onClick={() => setSelected(clip.id === selected ? null : clip.id)}
                  onDoubleClick={() => void api.openClip(clip.path)}
                >
                  <span className="clip__thumb">
                    {thumbs[clip.id] ? (
                      <img src={thumbs[clip.id]} alt="" loading="lazy" />
                    ) : (
                      <i className="ph ph-film-slate clip__placeholder" />
                    )}
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
