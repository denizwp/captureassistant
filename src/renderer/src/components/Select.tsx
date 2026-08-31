import { useCallback, useEffect, useId, useRef, useState } from 'react'

/** Mirrors `max-height` on `.select__popup`. */
const POPUP_MAX_H = 240

export interface SelectOption<T extends string> {
  value: T
  label: string
}

/**
 * Trigger plus popup listbox — deliberately not a native `<select>`, which on
 * Windows draws an OS dropdown that ignores the theme entirely.
 *
 * Keyboard contract matches the source design system: Enter/Space/ArrowDown
 * open, arrows move the active option, Enter/Space commit, Escape closes and
 * returns focus to the trigger.
 */
export function Select<T extends string>({
  options,
  value,
  onChange,
  placeholder = 'Seç',
  disabled,
  label
}: {
  options: SelectOption<T>[]
  value: T | null
  onChange: (next: T) => void
  placeholder?: string
  disabled?: boolean
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listboxId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  const openAtSelection = useCallback(() => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // The popup sits inside a scrolling pane, so near the bottom edge it would
    // be clipped. Measure once on open and flip it above the trigger.
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setDropUp(window.innerHeight - rect.bottom < POPUP_MAX_H + 16)
    setOpen(true)
  }, [selectedIndex])

  // Move DOM focus with the active index so `:focus` styling and screen
  // readers stay in step without a separate roving-tabindex scheme.
  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const commit = (index: number): void => {
    const option = options[index]
    if (option) onChange(option.value)
    close(true)
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((i) => (i + 1) % options.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((i) => (i - 1 + options.length) % options.length)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        close(true)
        break
    }
  }

  return (
    <div className="select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--secondary select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        disabled={disabled ?? false}
        onClick={() => (open ? close(false) : openAtSelection())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openAtSelection()
          }
        }}
      >
        <span className="select__value" {...(selected ? {} : { 'data-placeholder': '' })}>
          {selected?.label ?? placeholder}
        </span>
        <i className={`ph select__icon ${open ? 'ph-caret-up' : 'ph-caret-down'}`} />
      </button>

      <div
        id={listboxId}
        role="listbox"
        aria-label={label}
        className={`select__popup${dropUp ? ' select__popup--up' : ''}`}
        hidden={!open}
        onKeyDown={onListKeyDown}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={(el) => {
              optionRefs.current[index] = el
            }}
            type="button"
            role="option"
            aria-selected={option.value === value}
            className="select__option"
            tabIndex={-1}
            onClick={() => commit(index)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            {option.label}
            <i className="ph ph-check" />
          </button>
        ))}
      </div>
    </div>
  )
}
