import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { ArchiveEntry, ChatKind, ChatLine, ChatStatus } from '@shared/chat'
import { INITIAL_CHAT_STATUS, KIND_LABELS, spansFor } from '@shared/chat'
import { Section, Setting, Switch } from '../components/controls'
import { api } from '../api'
import { characterArt } from '../art'
import { formatBytes } from '../format'

const KINDS: ChatKind[] = ['ic', 'ooc', 'pm', 'info', 'system']

const STATE_TEXT: Record<ChatStatus['state'], { text: string; dot: string }> = {
  off: { text: 'Kapalı', dot: 'neutral' },
  waiting: { text: 'Oyun bekleniyor', dot: 'neutral' },
  connected: { text: 'Bağlı', dot: 'success' },
  error: { text: 'Hata', dot: 'danger' }
}

function Line({
  line,
  showTimestamps,
  useColors
}: {
  line: ChatLine
  showTimestamps: boolean
  useColors: boolean
}) {
  const spans = useColors
    ? spansFor(line.text, line.runs, line.kind)
    : [{ text: line.text, color: 'inherit' }]

  return (
    <div className={`chatline chatline--${line.kind}`}>
      {showTimestamps && line.at > 0 && (
        <span className="chatline__time mono">
          {new Date(line.at).toLocaleTimeString('tr-TR', { hour12: false })}
        </span>
      )}
      <span className="chatline__text">
        {spans.map((span, index) => (
          <span key={index} style={{ color: span.color }}>
            {span.text}
          </span>
        ))}
      </span>
    </div>
  )
}

export function ChatScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const { chat } = settings
  const [status, setStatus] = useState<ChatStatus>(INITIAL_CHAT_STATUS)
  const [live, setLive] = useState<ChatLine[]>([])
  const [archive, setArchive] = useState<ArchiveEntry[]>([])
  const [opened, setOpened] = useState<{ path: string; lines: ChatLine[] } | null>(null)
  const [kinds, setKinds] = useState<ChatKind[]>(KINDS)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.chatStatus().then(setStatus)
    void api.chatLines().then(setLive)
    const offStatus = api.on('chat-status', (payload) => setStatus(payload as ChatStatus))
    const offLines = api.on('chat-lines', (payload) => setLive(payload as ChatLine[]))
    return () => {
      offStatus()
      offLines()
    }
  }, [])

  const refreshArchive = useCallback(() => {
    void api.listChatArchive().then(setArchive)
  }, [])

  useEffect(refreshArchive, [refreshArchive, status.archiveFile])

  const source = opened ? opened.lines : live
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr')
    return source.filter(
      (line) =>
        kinds.includes(line.kind) &&
        (!needle || line.text.toLocaleLowerCase('tr').includes(needle))
    )
  }, [source, kinds, query])

  /*
   * Chat reads bottom-up: the line that just arrived is the one being waited
   * for. The view is dragged along only when it was already at the end, so
   * scrolling back to read something does not get yanked away mid-sentence.
   */
  const log = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const box = log.current
    if (!box || !chat.followTail) return
    if (pinned.current) box.scrollTop = box.scrollHeight
  }, [shown, chat.followTail])

  useEffect(() => {
    const box = log.current
    if (!box) return
    pinned.current = true
    box.scrollTop = box.scrollHeight
  }, [opened])

  const onScroll = (): void => {
    const box = log.current
    if (!box) return
    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  }

  const toggleKind = (kind: ChatKind): void =>
    setKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]
    )

  const doExport = async (format: 'txt' | 'html'): Promise<void> => {
    setBusy(true)
    try {
      await api.exportChat({
        source: opened ? opened.path : 'live',
        format,
        kinds,
        query: query.trim()
      })
    } finally {
      setBusy(false)
    }
  }

  const badge = STATE_TEXT[status.state]

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={characterArt} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Sohbet</span>
          <span className="badge badge--muted">
            <span className={`badge__dot badge__dot--${badge.dot}`} />
            {status.serverName && status.state === 'connected' ? status.serverName : badge.text}
          </span>
        </div>

        <div className="pane__body">
          {!chat.enabled ? (
            <div className="empty">
              <p className="empty__title">Sohbet takibi kapalı</p>
              <p className="empty__hint">
                Oyundaki sohbet arka planda birikir; sunucudaki renkleriyle burada akar, her gün
                ve her sunucu için ayrı bir dosyaya düşer. Rol, OOC ve özel mesajları ayırabilir,
                geçmişte arama yapabilir, istediğin kısmı TXT veya renkli HTML olarak dışarı
                alabilirsin. Klip kaydettiğinde o anın konuşması da klibin yanına yazılır.
              </p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => patch({ chat: { enabled: true } })}
              >
                <span className="btn__fill" />
                <span className="btn__label">Sohbet takibini aç</span>
              </button>
            </div>
          ) : (
            <>
              <div className="chatbar">
                <div className="chatbar__filters">
                  {KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={`chip${kinds.includes(kind) ? ' is-on' : ''}`}
                      onClick={() => toggleKind(kind)}
                    >
                      {KIND_LABELS[kind]}
                    </button>
                  ))}
                </div>
                <input
                  className="input chatbar__search"
                  type="search"
                  placeholder="Ara"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              <div className="chatbar chatbar--sub">
                <div className="chatbar__filters">
                  <button
                    type="button"
                    className={`chip${opened ? '' : ' is-on'}`}
                    onClick={() => setOpened(null)}
                  >
                    Canlı
                  </button>
                  {opened && (
                    <span className="chip is-on" title={opened.path}>
                      {opened.path.split('\\').pop()}
                    </span>
                  )}
                </div>
                <div className="chatbar__actions">
                  <span className="setting__hint">{shown.length} satır</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy || shown.length === 0}
                    onClick={() => void doExport('txt')}
                  >
                    <i className="ph ph-file-text" />
                    TXT
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy || shown.length === 0}
                    onClick={() => void doExport('html')}
                  >
                    <i className="ph ph-file-html" />
                    HTML
                  </button>
                </div>
              </div>

              <div className="chatlog" ref={log} onScroll={onScroll}>
                {shown.length === 0 ? (
                  <p className="empty__hint" style={{ padding: 'var(--space-4)' }}>
                    {source.length === 0
                      ? status.state === 'connected'
                        ? 'Bağlanıldı, ilk satır bekleniyor.'
                        : 'FiveM açılıp bir sunucuya bağlandığında satırlar buraya düşer.'
                      : 'Filtreye uyan satır yok.'}
                  </p>
                ) : (
                  shown.map((line) => (
                    <Line
                      key={line.id}
                      line={line}
                      showTimestamps={chat.showTimestamps}
                      useColors={chat.useServerColors}
                    />
                  ))
                )}
              </div>

              {chat.keepArchive && (
              <Section
                title="Arşiv"
                aside={
                  <div className="chatbar__actions">
                    {archive.length > 0 && (
                      <span className="setting__hint">{archive.length} gün</span>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void api.revealChatFolder()}
                    >
                      <i className="ph ph-folder-open" />
                      Klasörü aç
                    </button>
                  </div>
                }
              >
                {archive.length === 0 ? (
                  <p className="setting__hint">Henüz kaydedilmiş gün yok.</p>
                ) : (
                  <div className="archive">
                  {archive.map((entry) => (
                    <div className="setting" key={entry.path}>
                      <div className="setting__text">
                        <span className="label">{entry.server}</span>
                        <span className="setting__hint">
                          {new Date(entry.day).toLocaleDateString('tr-TR', {
                            day: '2-digit',
                            month: 'long',
                            year: 'numeric'
                          })}{' '}
                          · {formatBytes(entry.sizeBytes)}
                        </span>
                      </div>
                      <div className="setting__control">
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            void api.readChatArchive(entry.path).then((lines) => {
                              setOpened({ path: entry.path, lines })
                            })
                          }}
                        >
                          Aç
                        </button>
                      </div>
                    </div>
                  ))}
                  </div>
                )}
              </Section>
              )}
            </>
          )}

          <Section title="Ayarlar">
            <Setting
              label="Sohbet takibi"
              hint="FiveM'in ekranda gösterdiği sohbeti okur ve günlük dosyaya yazar."
              control={
                <Switch
                  label="Sohbet takibi"
                  checked={chat.enabled}
                  onChange={(enabled) => patch({ chat: { enabled } })}
                />
              }
            />
            <Setting
              label="Diske arşivle"
              hint="Kapalıyken sohbet yalnızca bu pencerede durur, diske hiçbir dosya yazılmaz. İstediğini elle TXT olarak alırsın."
              control={
                <Switch
                  label="Diske arşivle"
                  checked={chat.keepArchive}
                  disabled={!chat.enabled}
                  onChange={(keepArchive) => patch({ chat: { keepArchive } })}
                />
              }
            />
            <Setting
              label="Klibin yanına sohbeti de yaz"
              hint="Alt+F10 ile klip aldığında aynı dakikaların sohbeti klibin yanına metin dosyası olarak düşer. Videoya bir şey eklenmez."
              control={
                <Switch
                  label="Klibin yanına sohbeti de yaz"
                  checked={chat.saveWithClips}
                  disabled={!chat.enabled}
                  onChange={(saveWithClips) => patch({ chat: { saveWithClips } })}
                />
              }
            />
            <Setting
              label="Saat göster"
              control={
                <Switch
                  label="Saat göster"
                  checked={chat.showTimestamps}
                  onChange={(showTimestamps) => patch({ chat: { showTimestamps } })}
                />
              }
            />
            <Setting
              label="Yeni mesajda aşağı kay"
              hint="Açıkken en yeni satır görünür kalır. Geri kaydırıp okurken yerinden oynatmaz."
              control={
                <Switch
                  label="Yeni mesajda aşağı kay"
                  checked={chat.followTail}
                  onChange={(followTail) => patch({ chat: { followTail } })}
                />
              }
            />
            <Setting
              label="Sunucu renkleri"
              hint="Kapalıysa satırlar türlerine göre renklenir."
              control={
                <Switch
                  label="Sunucu renkleri"
                  checked={chat.useServerColors}
                  onChange={(useServerColors) => patch({ chat: { useServerColors } })}
                />
              }
            />
            {chat.keepArchive && (
            <Setting
              label="Arşiv klasörü"
              hint="Günlük metin dosyaları buraya yazılır."
              control={
                <div className="pathrow">
                  <span className="pathrow__value" title={chat.archiveDir ?? ''}>
                    {chat.archiveDir ?? 'Belgeler\\Capture Assistant Sohbet'}
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => {
                      void api.chooseDirectory(chat.archiveDir).then((dir) => {
                        if (dir) patch({ chat: { archiveDir: dir } })
                      })
                    }}
                  >
                    Değiştir
                  </button>
                </div>
              }
            />
            )}
            {status.error && status.state !== 'connected' && (
              <p className="section__note">Son durum: {status.error}</p>
            )}
          </Section>
        </div>
      </div>
    </main>
  )
}
