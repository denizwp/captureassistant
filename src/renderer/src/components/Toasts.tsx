import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

type ToastKind = 'info' | 'success' | 'warning' | 'error'

interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const ICONS: Record<ToastKind, string> = {
  info: 'ph-info',
  success: 'ph-check-circle',
  warning: 'ph-warning',
  error: 'ph-x-circle'
}

/** Errors stay up longer — they usually need reading twice. */
const LIFETIME: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  warning: 4500,
  error: 6000
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const unsubscribe = api.on('toast', (payload) => {
      const { kind, message } = payload as { kind: ToastKind; message: string }
      const id = nextId.current++
      setToasts((current) => [...current, { id, kind, message }])

      const timer = setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id))
        timers.delete(timer)
      }, LIFETIME[kind])
      timers.add(timer)
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
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <i className={`ph ${ICONS[toast.kind]}`} />
          {toast.message}
        </div>
      ))}
    </div>
  )
}
