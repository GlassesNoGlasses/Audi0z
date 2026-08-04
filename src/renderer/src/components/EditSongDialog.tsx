import { useState, type FormEvent, type ReactElement } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { errorMessage } from '../lib/errors'
import { useAppDispatch, useAppState } from '../state/AppContext'

export interface EditSongDialogProps {
  songId: string
}

/**
 * The title, and nothing else.
 *
 * Tags used to be edited here as a comma-separated string, which quietly made this a second place
 * a tag could be brought into existence. They are now a registry: which tags EXIST is the Tags
 * dialog's business, and which of them a song carries is ticked off in the row's own menu.
 */
export function EditSongDialog({ songId }: EditSongDialogProps): ReactElement | null {
  const { songs } = useAppState()
  const dispatch = useAppDispatch()
  const song = songs.find((entry) => entry.id === songId)
  const [title, setTitle] = useState(song?.title ?? '')
  const [saving, setSaving] = useState(false)

  const close = (): void => dispatch({ type: 'dialog/closed' })

  // Before the early return below: a hook may not sit behind a conditional.
  useEscapeKey(close)

  if (!song) return null

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed === '') return
    setSaving(true)
    void window.api.library
      .update(songId, { title: trimmed })
      .then((updated) => {
        dispatch({ type: 'library/songUpdated', song: updated })
        close()
      })
      .catch((error: unknown) => {
        dispatch({ type: 'toast/pushed', message: errorMessage(error) })
        setSaving(false)
      })
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Edit song">
        <h2>Edit song</h2>
        <form onSubmit={submit}>
          <label className="field">
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" disabled={saving || title.trim() === ''}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
