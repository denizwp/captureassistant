import { useEffect, useState } from 'react'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { Section, Setting, Slider, Switch } from '../components/controls'
import { Select } from '../components/Select'
import { api } from '../api'
import { characterArt } from '../art'

const DEFAULT_MIC = '__default__'
const FLOOR_DB = -60

function Meter({ db, active }: { db: number; active: boolean }) {
  const filled = active ? Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB)) : 0
  return (
    <div className="meter" title={active ? `${Math.round(db)} dBFS` : 'kapalı'}>
      <div className="meter__fill" style={{ width: `${filled * 100}%` }} />
    </div>
  )
}

export function AudioScreen({
  settings,
  patch
}: {
  settings: Settings
  patch: (next: DeepPartial<Settings>) => void
}) {
  const { audio } = settings
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  const [levels, setLevels] = useState({ system: FLOOR_DB, mic: FLOOR_DB })

  useEffect(() => {
  }, [])

  useEffect(() => {
    void api.listMicDevices().then(setDevices)
    const timer = setTimeout(() => void api.listMicDevices().then(setDevices), 1200)
    return () => clearTimeout(timer)
  }, [audio.micEnabled])

  useEffect(() => {
    void api.setMetering(true)
    const off = api.on('levels', (payload) =>
      setLevels(payload as { system: number; mic: number })
    )
    return () => {
      off()
      void api.setMetering(false)
    }
  }, [])

  return (
    <main className="content">
      <div className="pane">
        <img className="pane__art" src={characterArt} alt="" aria-hidden="true" />
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
            <Setting
              label="Giriş"
              hint="Sistemden şu anda gelen ses."
              control={
                <div style={{ width: 220 }}>
                  <Meter db={levels.system} active={audio.systemEnabled} />
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
              control={
                <div style={{ width: 260 }}>
                  <Select
                    label="Mikrofon cihazı"
                    disabled={!audio.micEnabled}
                    value={audio.micDeviceId ?? DEFAULT_MIC}
                    onChange={(id) =>
                      patch({ audio: { micDeviceId: id === DEFAULT_MIC ? null : id } })
                    }
                    options={[
                      { value: DEFAULT_MIC, label: 'Varsayılan mikrofon' },
                      ...devices.map((device) => ({ value: device.id, label: device.label }))
                    ]}
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
            <Setting
              label="Giriş"
              hint="Konuşunca burası hareket etmiyorsa yanlış cihaz seçili."
              control={
                <div style={{ width: 220 }}>
                  <Meter db={levels.mic} active={audio.micEnabled} />
                </div>
              }
            />
          </Section>
        </div>
      </div>
    </main>
  )
}
