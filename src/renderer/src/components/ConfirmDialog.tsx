import type { ReactElement } from 'react'

export interface ConfirmDialogProps {
  message: string
  confirmLabel: string
  onConfirm(): void
  onCancel(): void
}

/** Every destructive action goes through here — nothing is deleted on a single click. */
export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: ConfirmDialogProps): ReactElement {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Confirm">
        <p>{message}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
