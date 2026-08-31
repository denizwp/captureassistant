import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { Section, Setting, Slider, Switch } from '../components/controls'
import { Select } from '../components/Select'
import art from '../../assets/character-panel.png'

/** Sentinel for the system default device. */
const DEFAULT_MIC = '__default__'

export function AudioScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const { audio } = settings

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={art} alt="" aria-hidden="true" />
        <div className="pane__header">
          <span className="pane__title">Ses</span>
        </div>
        <div className="pane__body">
          <Section title="Sistem sesi">
            <Setting
              label="Sistem sesini kaydet"
              hint="Oyun ve masaüstü sesi."
              control={
                <Switch
                  label="Sistem sesini kaydet"
                  checked={audio.systemEnabled}
                  onChange={(systemEnabled) => patch({ audio: { systemEnabled } })}
                />
              }
            />
            <Setting
              label="Seviye"
              control={
                <div className="slider-row" style={{ width: 220 }}>
                  <Slider
                    label="Sistem sesi seviyesi"
                    min={0}
                    max={2}
                    step={0.05}
                    value={audio.systemGain}
                    disabled={!audio.systemEnabled}
                    onChange={(systemGain) => patch({ audio: { systemGain } })}
                  />
                  <span className="slider-row__value mono">
                    {Math.round(audio.systemGain * 100)}%
                  </span>
                </div>
              }
            />
          </Section>

          <Section title="Mikrofon">
            <Setting
              label="Mikrofonu kaydet"
              control={
                <Switch
                  label="Mikrofonu kaydet"
                  checked={audio.micEnabled}
                  onChange={(micEnabled) => patch({ audio: { micEnabled } })}
                />
              }
            />
            <Setting
              label="Cihaz"
              hint="Cihaz listesi kayıt motoru bağlandığında dolar."
              control={
                <div style={{ width: 260 }}>
                  <Select
                    label="Mikrofon cihazı"
                    disabled={!audio.micEnabled}
                    value={audio.micDeviceId ?? DEFAULT_MIC}
                    onChange={(id) =>
                      patch({ audio: { micDeviceId: id === DEFAULT_MIC ? null : id } })
                    }
                    options={[{ value: DEFAULT_MIC, label: 'Varsayılan mikrofon' }]}
                  />
                </div>
              }
            />
            <Setting
              label="Seviye"
              control={
                <div className="slider-row" style={{ width: 220 }}>
                  <Slider
                    label="Mikrofon seviyesi"
                    min={0}
                    max={2}
                    step={0.05}
                    value={audio.micGain}
                    disabled={!audio.micEnabled}
                    onChange={(micGain) => patch({ audio: { micGain } })}
                  />
                  <span className="slider-row__value mono">
                    {Math.round(audio.micGain * 100)}%
                  </span>
                </div>
              }
            />
          </Section>

          <Section title="Kanallar">
            <Setting
              label="Sesleri ayrı kanallara yaz"
              hint="Karışık ses ilk kanalda kalır; sistem ve mikrofon ayrıca ikinci ve üçüncü kanala yazılır, böylece sonradan ayrı düzenlenebilir."
              control={
                <Switch
                  label="Sesleri ayrı kanallara yaz"
                  checked={audio.separateTracks}
                  onChange={(separateTracks) => patch({ audio: { separateTracks } })}
                />
              }
            />
          </Section>
        </div>
      </div>
    </main>
  )
}
