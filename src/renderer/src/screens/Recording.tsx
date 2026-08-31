import { useEffect, useState } from 'react'
import type { DeepPartial } from '@shared/ipc'
import type { CodecId, QualityPreset, Settings } from '@shared/settings'
import { REPLAY_MAX_SEC, REPLAY_MIN_SEC, REPLAY_STEP_SEC } from '@shared/settings'
import { api, type MonitorInfo } from '../api'
import { estimateRingBytes, formatBytes, formatDuration } from '../format'
import { Section, Segmented, Setting, Slider, Switch } from '../components/controls'
import { Select } from '../components/Select'
import art from '../../assets/character-panel.png'

/** Worst-case ceilings the ring is sized against, matching the encoder args. */
const PRESET_MAXRATE_KBPS: Record<QualityPreset, number> = {
  low: 20_000,
  balanced: 50_000,
  high: 90_000
}

/** Sentinel for "whatever Windows calls primary", since null is not a value
 *  the listbox can carry. */
const PRIMARY = '__primary__'

const CODECS: { value: CodecId; label: string; hint: string }[] = [
  { value: 'h264', label: 'H.264', hint: 'Her yerde oynar' },
  { value: 'hevc', label: 'HEVC', hint: '~%35 küçük dosya, her yerde oynamayabilir' },
  { value: 'av1', label: 'AV1', hint: 'En küçük dosya, yeni GPU ve oynatıcı gerektirir' }
]

export function RecordingScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    void api.listMonitors().then(setMonitors)
  }, [])

  const { replay, capture } = settings
  const maxrate =
    capture.bitrateKbps > 0 ? capture.bitrateKbps : PRESET_MAXRATE_KBPS[capture.preset]
  const ringBytes = estimateRingBytes(replay.durationSec, maxrate)

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Kayıt</span>
        </div>
        <div className="pane__body">
          <Section title="Geçmiş kayıt">
            <Setting
              label="Geçmiş kaydı aç"
              hint="Sürekli arka planda kaydeder; kısayola bastığında geçmiş süreyi diske yazar."
              control={
                <Switch
                  label="Geçmiş kaydı aç"
                  checked={replay.enabled}
                  onChange={(enabled) => patch({ replay: { enabled } })}
                />
              }
            />

            <Setting
              stacked
              label={`Kaydedilecek süre — ${formatDuration(replay.durationSec)}`}
              hint={`Diskte ~${formatBytes(ringBytes)} yer tutar. 30 saniyelik adımlarla ayarlanır.`}
              control={
                <div className="slider-row">
                  <Slider
                    label="Kaydedilecek süre"
                    min={REPLAY_MIN_SEC}
                    max={REPLAY_MAX_SEC}
                    step={REPLAY_STEP_SEC}
                    value={replay.durationSec}
                    onChange={(durationSec) => patch({ replay: { durationSec } })}
                  />
                  <span className="slider-row__value mono">
                    {formatDuration(replay.durationSec)}
                  </span>
                </div>
              }
            />

            <Setting
              label="Kısayoldan sonraki süre"
              hint="Tuşa bastıktan sonra kaç saniye daha kaydedilsin."
              control={
                <div className="slider-row" style={{ width: 220 }}>
                  <Slider
                    label="Kısayoldan sonraki süre"
                    min={0}
                    max={15}
                    step={1}
                    value={replay.postRollSec}
                    onChange={(postRollSec) => patch({ replay: { postRollSec } })}
                  />
                  <span className="slider-row__value mono">{replay.postRollSec}sn</span>
                </div>
              }
            />
          </Section>

          <Section title="Kalite">
            <Setting
              label="Ön ayar"
              hint="Çözünürlük ve bitrate'i birlikte belirler."
              control={
                <Segmented<QualityPreset>
                  value={capture.preset}
                  onChange={(preset) => patch({ capture: { preset } })}
                  options={[
                    { value: 'low', label: 'Düşük' },
                    { value: 'balanced', label: 'Dengeli' },
                    { value: 'high', label: 'Yüksek' }
                  ]}
                />
              }
            />

            <Setting
              label="Gelişmiş"
              hint="FPS, bitrate, codec ve çözünürlük ölçeğini elle ayarla."
              control={
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((v) => !v)}
                >
                  <i className={`ph ${advanced ? 'ph-caret-up' : 'ph-caret-down'}`} />
                  {advanced ? 'Gizle' : 'Göster'}
                </button>
              }
            />

            {advanced && (
              <>
                <Setting
                  label="Kare hızı"
                  control={
                    <Segmented<string>
                      value={String(capture.fps)}
                      onChange={(fps) => patch({ capture: { fps: Number(fps) } })}
                      options={[
                        { value: '30', label: '30' },
                        { value: '60', label: '60' },
                        { value: '120', label: '120' }
                      ]}
                    />
                  }
                />
                <Setting
                  label="Codec"
                  hint={CODECS.find((c) => c.value === capture.codec)?.hint ?? ''}
                  control={
                    <Segmented<CodecId>
                      value={capture.codec}
                      onChange={(codec) => patch({ capture: { codec } })}
                      options={CODECS.map((c) => ({ value: c.value, label: c.label }))}
                    />
                  }
                />
                <Setting
                  label="Çözünürlük ölçeği"
                  hint="GPU üzerinde küçültülür; dosya boyutunu ve encoder yükünü düşürür."
                  control={
                    <Segmented<string>
                      value={String(capture.scale)}
                      onChange={(scale) => patch({ capture: { scale: Number(scale) } })}
                      options={[
                        { value: '0.5', label: '%50' },
                        { value: '0.75', label: '%75' },
                        { value: '1', label: 'Tam' }
                      ]}
                    />
                  }
                />
                <Setting
                  stacked
                  label={`Bitrate tavanı — ${(maxrate / 1000).toFixed(0)} Mbps`}
                  hint="0 bırakılırsa ön ayardan gelir. Tampon boyutu bu tavana göre hesaplanır."
                  control={
                    <div className="slider-row">
                      <Slider
                        label="Bitrate tavanı"
                        min={5000}
                        max={150000}
                        step={5000}
                        value={maxrate}
                        onChange={(bitrateKbps) => patch({ capture: { bitrateKbps } })}
                      />
                      <span className="slider-row__value mono">
                        {(maxrate / 1000).toFixed(0)}M
                      </span>
                    </div>
                  }
                />
              </>
            )}
          </Section>

          <Section title="Kaynak ve hedef">
            <Setting
              label="Ekran"
              control={
                <div style={{ width: 260 }}>
                  <Select
                    label="Ekran"
                    value={capture.monitorId ?? PRIMARY}
                    onChange={(id) => patch({ capture: { monitorId: id === PRIMARY ? null : id } })}
                    options={[
                      { value: PRIMARY, label: 'Birincil ekran' },
                      ...monitors.map((monitor) => ({
                        value: monitor.id,
                        label: `${monitor.label} — ${monitor.width}×${monitor.height}`
                      }))
                    ]}
                  />
                </div>
              }
            />
            <Setting
              stacked
              label="Kayıt klasörü"
              hint="Klipler buraya yazılır. OneDrive gibi senkron edilen bir klasör seçme."
              control={
                <div className="pathrow">
                  <span className="pathrow__value" title={settings.output.dir ?? ''}>
                    {settings.output.dir ?? 'Videolar\\Capture Assistant'}
                  </span>
                  <button type="button" className="btn btn--secondary">
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
