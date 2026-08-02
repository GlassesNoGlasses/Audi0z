import type { ReactElement } from 'react'
import { useAppDispatch, useAppState } from '../state/AppContext'

/**
 * Stacked, dismissible messages — failures forwarded by the main process and anything the renderer
 * could not complete. Nothing expires on a timer: a message the user never saw is worse than one
 * that waits for a click.
 */
export function ToastHost(): ReactElement | null {
  const { toasts } = useAppState()
  const dispatch = useAppDispatch()
  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" role="alert">
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: 'toast/dismissed', id: toast.id })}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
