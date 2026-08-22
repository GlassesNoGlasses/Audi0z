import { useCallback, useEffect, type ReactElement } from 'react'
import { useAppDispatch, useAppState } from '../state/AppContext'
import type { Toast } from '../state/appReducer'

/** Long enough to read a stderr tail, short enough that the capped stack clears itself. */
const TOAST_TTL_MS = 10_000

interface ToastItemProps {
  toast: Toast
  onDismiss(id: number): void
}

/** The timer lives here, not in the host, so each toast counts its own TTL from arrival. */
function ToastItem({ toast, onDismiss }: ToastItemProps): ReactElement {
  const { id } = toast

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), TOAST_TTL_MS)
    return () => clearTimeout(timer)
  }, [onDismiss, id])

  return (
    <div className="toast" role="alert">
      <span className="toast-message">{toast.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => onDismiss(id)}>
        ✕
      </button>
    </div>
  )
}

/** Stacked, dismissible messages; each expires on its own after {@link TOAST_TTL_MS}. */
export function ToastHost(): ReactElement | null {
  const { toasts } = useAppState()
  const dispatch = useAppDispatch()

  // Memoised deliberately: an unstable callback would re-arm every toast's timer on each render.
  const dismiss = useCallback((id: number) => dispatch({ type: 'toast/dismissed', id }), [dispatch])

  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  )
}
