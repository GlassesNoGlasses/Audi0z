import { useCallback, useEffect, type ReactElement } from 'react'
import { useAppDispatch, useAppState } from '../state/AppContext'
import type { Toast } from '../state/appReducer'

/**
 * How long a toast stays up. Long enough to read a multi-line stderr tail, short enough that the
 * corner clears itself — the stack is capped, so a message nobody dismissed would otherwise sit
 * there hiding the next failure.
 */
const TOAST_TTL_MS = 10_000

interface ToastItemProps {
  toast: Toast
  onDismiss(id: number): void
}

/**
 * One message, on its own clock.
 *
 * The timer lives down here rather than in the host so each toast counts its own ten seconds from
 * when it appeared: a second failure arriving late must not extend the first one's stay, nor be
 * cut short by it.
 */
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

/**
 * Stacked, dismissible messages — failures forwarded by the main process and anything the renderer
 * could not complete. Each expires on its own after {@link TOAST_TTL_MS}, and the dismiss button
 * gets rid of one sooner.
 */
export function ToastHost(): ReactElement | null {
  const { toasts } = useAppState()
  const dispatch = useAppDispatch()

  // Memoised deliberately: an unstable callback would re-arm every toast's timer on every render
  // of the host, so pushing a second message would keep the first one alive indefinitely.
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
