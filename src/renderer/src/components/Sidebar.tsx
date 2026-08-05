import { useState, type FormEvent, type ReactElement } from 'react'
import type { Playlist } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { LIBRARY_QUEUE_ID } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'

/**
 * Library + playlists, and the only place the VIEW is chosen.
 *
 * Selecting an entry changes what is listed and nothing else — the queue and the music carry on
 * untouched. Browsing is not a transport control: the queue follows only when the user plays a
 * song from the view they moved to (`SongList`). Expanding an entry to peek at its songs is
 * deliberately not even a view change.
 *
 * Which is why the entries carry two independent marks: `aria-current` is the view the user is
 * browsing, and `is-playing-source` is where the sound is coming from. Wander off the playing
 * playlist and they part company — that parting is the whole point of the second one.
 *
 * The playlist filter is local state, like `AddToPlaylistDialog`'s: the store's `query` is the song
 * list's, and narrowing the sidebar is not a request to narrow what is being browsed.
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

  // `lib/search` exports only the songs filter, which searches tags as well — a playlist has none,
  // so this is the plain case-insensitive substring match instead.
  const shown = playlists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.trim().toLowerCase())
  )

  // Dragging rearranges the stored order, so it is only offered when the rows on screen ARE that
  // order: a filtered list says nothing about where the hidden playlists go, and a row that is
  // being renamed has a text field in it that a drag would fight for the pointer.
  const canDrag = filter.trim() === '' && renamingId === null

  // Cued-but-silent (the boot state) is not "playing from": the marker needs a current song. Boot
  // loads the library queue whether or not anyone has pressed play, so `queueId` alone would light
  // Library up on a silent app. Deleting the playing playlist nulls `queueId`, so this self-clears.
  const playingQueueId = playback.currentId === null ? null : playback.queueId

  const titleOf = (songId: string): string =>
    songs.find((song) => song.id === songId)?.title ?? 'Unknown song'

  const fail = (error: unknown): void =>
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })

  function selectLibrary(): void {
    dispatch({ type: 'view/selected', view: { kind: 'library' } })
  }

  function selectPlaylist(playlist: Playlist): void {
    dispatch({ type: 'view/selected', view: { kind: 'playlist', id: playlist.id } })
  }

  function create(event: FormEvent): void {
    event.preventDefault()
    const name = newName.trim()
    if (name === '') return
    setCreating(false)
    setNewName('')
    void window.api.playlists
      .create(name)
      .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
      .catch(fail)
  }

  function rename(event: FormEvent, playlistId: string): void {
    event.preventDefault()
    const name = renameValue.trim()
    setRenamingId(null)
    if (name === '') return
    void window.api.playlists
      .rename(playlistId, name)
      .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
      .catch(fail)
  }

  /**
   * Lands the drag: the dragged id is pulled out of the order and put back beside the target, and
   * the store's answer — not the arithmetic here — is what the list is redrawn from.
   */
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
      <h1>my-music-library</h1>
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
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', playlist.id)
                  setDragId(playlist.id)
                }}
                // The `dragId === null` guards below are what keep a file dragged in from the OS
                // falling through to the app root's add-dialog drop: a drag is ours only between
                // our own dragStart and dragEnd, and anything else is left entirely alone.
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

      {/* Outside the nav, so the list scrolls past it and no number of playlists can push the one
          way of making another below the fold. */}
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
