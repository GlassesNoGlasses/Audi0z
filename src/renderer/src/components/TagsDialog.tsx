import { useState, type FormEvent, type ReactElement } from 'react'
import type { Tag } from '../../../shared/types'
import { refreshLibrary, refreshTags } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { errorMessage } from '../lib/errors'
import { readableTextColor } from '../lib/format'
import { useAppDispatch, useAppState } from '../state/AppContext'

/**
 * The registry, and the only place a tag is created, renamed or deleted. Which tags a *song*
 * carries is chosen on the song itself; this dialog is about which tags exist at all.
 *
 * Renaming and deleting cascade through every song that carries the tag, and the main process
 * announces no library change when they do — so both re-read the library as well as the registry,
 * or the rows behind the dialog would keep showing the old name until something else refreshed
 * them.
 */
export function TagsDialog(): ReactElement {
  const { tags } = useAppState()
  const dispatch = useAppDispatch()
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  useEscapeKey(close)

  const fail = (error: unknown): void =>
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })

  function create(event: FormEvent): void {
    event.preventDefault()
    const name = newName.trim()
    if (name === '') return
    setNewName('')
    void window.api.tags
      .create(name)
      .then(() => refreshTags(dispatch))
      .catch(fail)
  }

  function rename(event: FormEvent, tagId: string): void {
    event.preventDefault()
    const name = renameValue.trim()
    setRenamingId(null)
    if (name === '') return
    void window.api.tags
      .rename(tagId, name)
      .then(() => refreshLibrary(dispatch))
      .catch(fail)
  }

  function remove(tagId: string): void {
    setConfirmingId(null)
    void window.api.tags
      .remove(tagId)
      .then(() => refreshLibrary(dispatch))
      .catch(fail)
  }

  const confirming = tags.find((tag) => tag.id === confirmingId) ?? null

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Tags">
        <h2>Tags</h2>

        {tags.length === 0 ? (
          <p className="dialog-hint">No tags yet.</p>
        ) : (
          <div className="tag-chips">
            {tags.map((tag) =>
              renamingId === tag.id ? (
                <form
                  key={tag.id}
                  className="inline-form"
                  onSubmit={(event) => rename(event, tag.id)}
                >
                  <input
                    autoFocus
                    aria-label="Tag name"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                  <button type="submit">Save</button>
                </form>
              ) : (
                <Chip
                  key={tag.id}
                  tag={tag}
                  onRename={() => {
                    setConfirmingId(null)
                    setRenamingId(tag.id)
                    setRenameValue(tag.name)
                  }}
                  onDelete={() => setConfirmingId(tag.id)}
                />
              )
            )}
          </div>
        )}

        {/*
          Deleting is confirmed inside this dialog rather than through the global one: there is a
          single dialog slot, so opening that would close this — and the user would be back to the
          song list with the registry half-edited.
        */}
        {confirming ? (
          <div className="confirm-strip">
            <span>
              Delete tag &quot;{confirming.name}&quot;? It will be removed from every song.
            </span>
            <button type="button" onClick={() => setConfirmingId(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={() => remove(confirming.id)}>
              Delete
            </button>
          </div>
        ) : null}

        <form className="inline-form" onSubmit={create}>
          <input
            aria-label="New tag name"
            placeholder="New tag"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <button type="submit">Create tag</button>
        </form>

        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

interface ChipProps {
  tag: Tag
  onRename(): void
  onDelete(): void
}

/** A GitHub-style label: the tag's own colour, in whichever ink can be read against it. */
function Chip({ tag, onRename, onDelete }: ChipProps): ReactElement {
  return (
    <span
      className="tag-chip"
      style={{ background: tag.color, color: readableTextColor(tag.color) }}
    >
      <span className="tag-name">{tag.name}</span>
      <button type="button" aria-label={`Rename tag ${tag.name}`} onClick={onRename}>
        ✎
      </button>
      <button type="button" aria-label={`Delete tag ${tag.name}`} onClick={onDelete}>
        ✕
      </button>
    </span>
  )
}
