import { useState, type ReactElement } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { errorMessage } from '../lib/errors'
import { useAppDispatch, useAppState } from '../state/AppContext'

export function SettingsDialog(): ReactElement {
  const { settings } = useAppState()
  const dispatch = useAppDispatch()
  const [updating, setUpdating] = useState(false)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  useEscapeKey(close)

  const fail = (error: unknown): void =>
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })

  function toggleCompress(compressByDefault: boolean): void {
    void window.api.settings
      .set({ compressByDefault })
      .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
      .catch(fail)
  }

  function updateYtDlp(): void {
    setUpdating(true)
    void window.api.ytdlp
      .update()
      .then(({ version }) =>
        dispatch({ type: 'toast/pushed', message: `yt-dlp updated to ${version}` })
      )
      .catch(fail)
      .finally(() => setUpdating(false))
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>Settings</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.compressByDefault}
            onChange={(event) => toggleCompress(event.target.checked)}
          />
          Compress new songs by default
        </label>
        <p className="dialog-hint">
          Compression re-encodes to Opus 128k on the way in. It saves space and loses a little
          quality.
        </p>
        <div className="dialog-actions">
          <button type="button" disabled={updating} onClick={updateYtDlp}>
            Update yt-dlp
          </button>
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
