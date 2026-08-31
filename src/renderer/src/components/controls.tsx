import type { ReactNode } from 'react'

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled ?? false}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Slider({
  min,
  max,
  step,
  value,
  onChange,
  disabled,
  label
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (next: number) => void
  disabled?: boolean
  label: string
}) {
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="slider"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled ?? false}
      style={{ '--fill': `${fill}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'is-active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Setting({
  label,
  hint,
  control,
  stacked
}: {
  label: string
  hint?: string
  control: ReactNode
  stacked?: boolean
}) {
  return (
    <div className={stacked ? 'setting setting--stacked' : 'setting'}>
      <div className="setting__text">
        <span className="label">{label}</span>
        {hint ? <span className="setting__hint">{hint}</span> : null}
      </div>
      <div className="setting__control">{control}</div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section__title">{title}</h2>
      {children}
    </section>
  )
}

export function Keys({ combo }: { combo: string }) {
  const keys = combo.split('+')
  return (
    <>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`} className="kbd">
          {key}
        </span>
      ))}
    </>
  )
}
