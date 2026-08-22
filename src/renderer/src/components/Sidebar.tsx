import { useMemo, useState, type FormEvent, type ReactElement } from 'react'
import type { Playlist } from '../../../shared/types'
import { useToastError } from '../hooks/useToastError'
import { LIBRARY_QUEUE_ID } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'

/** Plain substring match, not `lib/search`: that one also searches tags, which a playlist has none of. */
function matchesFilter(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter.trim().toLowerCase())
}

/**
 * Library + playlists, and the only place the VIEW is chosen — browsing never moves the queue.
 * Hence two marks: `aria-current` is the browsed view, `is-playing-source` is where sound plays.
 */
export function Sidebar(): ReactElement {
  const { songs, playlists, view, expandedPlaylists, playback } = useAppState()
  const dispatch = useAppDispatch()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [filter, setFilter] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropMark, setDropMark] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)

  const shown = playlists.filter((playlist) => matchesFilter(playlist.name, filter))

  // Drag only when the rows on screen ARE the stored order: a filter hides where the rest go, and
  // a rename row has a text field a drag would fight for the pointer.
  const canDrag = filter.trim() === '' && renamingId === null

  // Cued-but-silent (boot) is not "playing from": boot loads the library queue with nothing playing.
  const playingQueueId = playback.currentId === null ? null : playback.queueId

  // Indexed once per library change: this re-renders on every state change, and a per-row scan
  // would walk the whole library for each song of each expanded playlist.
  const titleById = useMemo(() => new Map(songs.map((song) => [song.id, song.title])), [songs])

  const titleOf = (songId: string): string => titleById.get(songId) ?? 'Unknown song'

  const fail = useToastError()

  function selectLibrary(): void {
    dispatch({ type: 'view/selected', view: { kind: 'library' } })
  }

  function selectPlaylist(playlist: Playlist): void {
    dispatch({ type: 'view/selected', view: { kind: 'playlist', id: playlist.id } })
  }

  /** Lands a create/rename, spending the filter only when it would hide the just-written name. */
  function applyWrite(playlist: Playlist): void {
    dispatch({ type: 'playlists/upserted', playlist })
    setFilter((current) => (matchesFilter(playlist.name, current) ? current : ''))
  }

  function create(event: FormEvent): void {
    event.preventDefault()
    const name = newName.trim()
    if (name === '') return
    setCreating(false)
    setNewName('')
    void window.api.playlists.create(name).then(applyWrite).catch(fail)
  }

  function rename(event: FormEvent, playlistId: string): void {
    event.preventDefault()
    const name = renameValue.trim()
    setRenamingId(null)
    if (name === '') return
    void window.api.playlists.rename(playlistId, name).then(applyWrite).catch(fail)
  }

  /** Lands the drag; the list is redrawn from the store's answer, not from the arithmetic here. */
  function commitReorder(targetId: string, edge: 'before' | 'after'): void {
    if (dragId === null || dragId === targetId) return
    const ids = playlists.map((playlist) => playlist.id).filter((id) => id !== dragId)
    const at = ids.indexOf(targetId)
    if (at === -1) return
    ids.splice(edge === 'before' ? at : at + 1, 0, dragId)
    void window.api.playlists
      .reorder(ids)
      .then((next) => dispatch({ type: 'playlists/loaded', playlists: next }))
      .catch(fail)
  }

  return (
    <aside className="sidebar">
      <h1>Audi0z</h1>
      <nav className="sidebar-nav">
        <button
          type="button"
          className={
            playingQueueId === LIBRARY_QUEUE_ID
              ? 'sidebar-entry is-playing-source'
              : 'sidebar-entry'
          }
          aria-current={view.kind === 'library' ? 'true' : undefined}
          onClick={selectLibrary}
        >
          Library
        </button>

        <input
          className="sidebar-search"
          type="search"
          aria-label="Search playlists"
          placeholder="Search playlists"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />

        <ul className="playlist-list">
          {/* A list that just empties reads as though the playlists went, not as a filter biting. */}
          {shown.length === 0 && playlists.length > 0 ? (
            <li className="playlist-empty">no playlists match</li>
          ) : null}
          {shown.map((playlist) => {
            const expanded = expandedPlaylists.has(playlist.id)
            return (
              <li
                key={playlist.id}
                className={`playlist-item${dropMark?.id === playlist.id ? ` drop-${dropMark.edge}` : ''}`}
                draggable={canDrag}
                onDragStart={(event) => {
                  if (!canDrag) return
                  // No setData: the drop path reads state, and a text/plain payload would only feed our own inputs.
                  event.dataTransfer.effectAllowed = 'move'
                  setDragId(playlist.id)
                }}
                // A drag is ours only between our own dragStart and dragEnd; the `dragId === null`
                // guards leave every other drag completely alone.
                onDragOver={(event) => {
                  if (dragId === null) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect()
                  const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  if (dropMark?.id !== playlist.id || dropMark.edge !== edge) {
                    setDropMark({ id: playlist.id, edge })
                  }
                }}
                onDrop={(event) => {
                  if (dragId === null) return
                  event.preventDefault()
                  event.stopPropagation()
                  if (dropMark !== null) commitReorder(dropMark.id, dropMark.edge)
                  setDragId(null)
                  setDropMark(null)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setDropMark(null)
                }}
              >
                <div className="playlist-row">
                  <button
                    type="button"
                    className="chevron"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${playlist.name}`}
                    onClick={() =>
                      dispatch({ type: 'playlist/expandToggled', playlistId: playlist.id })
                    }
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  {renamingId === playlist.id ? (
                    <form className="inline-form" onSubmit={(event) => rename(event, playlist.id)}>
                      <input
                        autoFocus
                        aria-label="Playlist name"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                      <button type="submit">Save name</button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={
                          playingQueueId === playlist.id
                            ? 'sidebar-entry is-playing-source'
                            : 'sidebar-entry'
                        }
                        aria-current={
                          view.kind === 'playlist' && view.id === playlist.id ? 'true' : undefined
                        }
                        onClick={() => selectPlaylist(playlist)}
                      >
                        {playlist.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Rename ${playlist.name}`}
                        onClick={() => {
                          setRenamingId(playlist.id)
                          setRenameValue(playlist.name)
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete playlist ${playlist.name}`}
                        onClick={() =>
                          dispatch({
                            type: 'dialog/opened',
                            dialog: {
                              kind: 'confirm',
                              message: `Delete the playlist "${playlist.name}"? Its songs stay in the library.`,
                              confirmLabel: 'Delete',
                              intent: { kind: 'deletePlaylist', playlistId: playlist.id }
                            }
                          })
                        }
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
                {expanded ? (
                  <ul className="playlist-songs">
                    {/* An expansion that renders nothing reads as broken rather than as empty. */}
                    {playlist.songIds.length === 0 ? (
                      <li className="playlist-empty">playlist is empty</li>
                    ) : (
                      playlist.songIds.map((songId) => <li key={songId}>{titleOf(songId)}</li>)
                    )}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Outside the nav, so no number of playlists can push it below the fold. */}
      <div className="sidebar-footer">
        {creating ? (
          <form className="inline-form" onSubmit={create}>
            <input
              autoFocus
              aria-label="New playlist name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit">Create</button>
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="sidebar-action" onClick={() => setCreating(true)}>
            New playlist
          </button>
        )}
      </div>
    </aside>
  )
}
