import { useState, type FormEvent, type ReactElement } from 'react'
import type { Playlist } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { useAppDispatch, useAppState } from '../state/AppContext'

/**
 * Library + playlists, and the only place the VIEW is chosen.
 *
 * Selecting an entry changes what is listed and nothing else — the queue and the music carry on
 * untouched. Browsing is not a transport control: the queue follows only when the user plays a
 * song from the view they moved to (`SongList`). Expanding an entry to peek at its songs is
 * deliberately not even a view change.
 */
export function Sidebar(): ReactElement {
  const { songs, playlists, view, expandedPlaylists } = useAppState()
  const dispatch = useAppDispatch()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

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

  return (
    <aside className="sidebar">
      <h1>my-music-library</h1>
      <nav className="sidebar-nav">
        <button
          type="button"
          className="sidebar-entry"
          aria-current={view.kind === 'library' ? 'true' : undefined}
          onClick={selectLibrary}
        >
          Library
        </button>

        <ul className="playlist-list">
          {playlists.map((playlist) => {
            const expanded = expandedPlaylists.has(playlist.id)
            return (
              <li key={playlist.id}>
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
                        className="sidebar-entry"
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
      </nav>
    </aside>
  )
}
