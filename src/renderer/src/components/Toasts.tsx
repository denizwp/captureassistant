import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

type ToastKind = 'info' | 'success' | 'warning' | 'error'

interface Toast {
  id: number
  kind: ToastKind
  message: string
  leaving: boolean
}

const ICONS: Record<ToastKind, string> = {
  info: 'ph-info',
  success: 'ph-check-circle',
  warning: 'ph-warning',
  error: 'ph-x-circle'
}

const LIFETIME: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  warning: 4500,
  error: 6000
}

const EXIT_MS = 200

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const unsubscribe = api.on('toast', (payload) => {
      const { kind, message } = payload as { kind: ToastKind; message: string }
      const id = nextId.current++
      setToasts((current) => [...current, { id, kind, message, leaving: false }])

      const fade = setTimeout(() => {
        setToasts((current) => current.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
        timers.delete(fade)

        const drop = setTimeout(() => {
          setToasts((current) => current.filter((t) => t.id !== id))
          timers.delete(drop)
        }, EXIT_MS)
        timers.add(drop)
      }, LIFETIME[kind])
      timers.add(fade)
    })

    return () => {
      unsubscribe()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.kind}${toast.leaving ? ' is-leaving' : ''}`}
        >
          <i className={`ph ${ICONS[toast.kind]}`} />
          {toast.message}
        </div>
      ))}
    </div>
  )
}
