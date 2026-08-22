import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useToastError } from '../hooks/useToastError'
import { useAppDispatch, useAppState } from '../state/AppContext'

export interface EditSongDialogProps {
  songId: string
}

/** Title only — tags are a registry, owned by the Tags dialog and the row's own menu. */
export function EditSongDialog({ songId }: EditSongDialogProps): ReactElement | null {
  const { songs } = useAppState()
  const dispatch = useAppDispatch()
  const song = songs.find((entry) => entry.id === songId)
  const [title, setTitle] = useState(song?.title ?? '')
  const [saving, setSaving] = useState(false)

  const close = (): void => dispatch({ type: 'dialog/closed' })

  // Before the early return below: a hook may not sit behind a conditional.
  useEscapeKey(close)
  const fail = useToastError()

  // Deleted from under the dialog: both delete paths dismiss, then await `library.remove`.
  // Closing frees the dialog slot — the early return alone would leave it occupied.
  useEffect(() => {
    if (!song) dispatch({ type: 'dialog/closed' })
  }, [song, dispatch])

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
        fail(error)
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
            <p>{title.trim().length <= 0 && 'Title must be at least 1 character'}</p>
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
