import type { DeepPartial } from '@shared/ipc'
import type { IndicatorCorner, Settings } from '@shared/settings'
import { api } from '../api'
import { Section, Segmented, Setting, Slider, Switch } from '../components/controls'
import art from '../../assets/character-panel.png'

const CORNERS: { value: IndicatorCorner; label: string }[] = [
  { value: 'bottom-right', label: 'Sağ alt' },
  { value: 'bottom-left', label: 'Sol alt' },
  { value: 'top-right', label: 'Sağ üst' },
  { value: 'top-left', label: 'Sol üst' }
]

export function GeneralScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const { app, replay } = settings

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Genel</span>
        </div>
        <div className="pane__body">
          <Section title="Uygulama">
            <Setting
              label="Kapatınca sistem tepsisine küçült"
              hint="Pencere kapanır, geçmiş kayıt çalışmaya devam eder."
              control={
                <Switch
                  label="Kapatınca sistem tepsisine küçült"
                  checked={app.minimizeToTray}
                  onChange={(minimizeToTray) => patch({ app: { minimizeToTray } })}
                />
              }
            />
            <Setting
              label="Windows açılışında başlat"
              hint="Tepsiye gizli olarak açılır."
              control={
                <Switch
                  label="Windows açılışında başlat"
                  checked={app.launchAtLogin}
                  onChange={(launchAtLogin) => patch({ app: { launchAtLogin } })}
                />
              }
            />
            <Setting
              label="Tema"
              control={
                <Segmented<'dark' | 'light'>
                  value={app.theme}
                  onChange={(theme) => patch({ app: { theme } })}
                  options={[
                    { value: 'dark', label: 'Koyu' },
                    { value: 'light', label: 'Açık' }
                  ]}
                />
              }
            />
          </Section>

          <Section title="Ekran göstergeleri">
            <Setting
              label="Ses efektleri"
              hint="Kayıt başlarken, dururken ve klip kaydedilirken kısa bir ton çalar."
              control={
                <Switch
                  label="Ses efektleri"
                  checked={app.soundCues}
                  onChange={(soundCues) => patch({ app: { soundCues } })}
                />
              }
            />
            <Setting
              label="Konum"
              control={
                <Segmented<IndicatorCorner>
                  value={app.indicatorCorner}
                  onChange={(indicatorCorner) => patch({ app: { indicatorCorner } })}
                  options={CORNERS}
                />
              }
            />
            <Setting
              label="Opaklık"
              control={
                <div className="slider-row" style={{ width: 220 }}>
                  <Slider
                    label="Gösterge opaklığı"
                    min={0.3}
                    max={1}
                    step={0.05}
                    value={app.indicatorOpacity}
                    onChange={(indicatorOpacity) => patch({ app: { indicatorOpacity } })}
                  />
                  <span className="slider-row__value mono">
                    {Math.round(app.indicatorOpacity * 100)}%
                  </span>
                </div>
              }
            />
            <Setting
              label="Rozetleri her zaman göster"
              hint="Tam ekran oyunlarda FPS düşürebilir ve G-Sync'i devre dışı bırakabilir. Kapalıyken rozetler oyun içinde yalnızca durum değişiminde kısaca belirir."
              control={
                <Switch
                  label="Rozetleri her zaman göster"
                  checked={app.alwaysShowIndicators}
                  onChange={(alwaysShowIndicators) => patch({ app: { alwaysShowIndicators } })}
                />
              }
            />
          </Section>

          <Section title="Tampon klasörü">
            <Setting
              stacked
              label="Geçici segmentlerin yazıldığı yer"
              hint="Hızlı bir SSD tercih et. Bu klasöre sürekli yazılır; mekanik disk klip hazırlamayı dakikalara çıkarır."
              control={
                <div className="pathrow">
                  <span className="pathrow__value" title={replay.bufferDir ?? ''}>
                    {replay.bufferDir ?? 'Uygulama verisi\\ring'}
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => {
                      void api.chooseDirectory(replay.bufferDir).then((dir) => {
                        if (dir) patch({ replay: { bufferDir: dir } })
                      })
                    }}
                  >
                    Değiştir
                  </button>
                </div>
              }
            />
          </Section>
        </div>
      </div>
    </main>
  )
}
