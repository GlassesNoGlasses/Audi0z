import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useToastError } from '../hooks/useToastError'
import { formatDuration } from '../lib/format'
import { filterSongs } from '../lib/search'
import { useAppDispatch, useAppState } from '../state/AppContext'

export interface AddToPlaylistDialogProps {
  playlistId: string
}

/** Its own search, over the whole library: the point is to reach songs the view is hiding. */
export function AddToPlaylistDialog({ playlistId }: AddToPlaylistDialogProps): ReactElement | null {
  const { songs, playlists } = useAppState()
  const dispatch = useAppDispatch()
  const [query, setQuery] = useState('')

  const playlist = playlists.find((entry) => entry.id === playlistId) ?? null

  const close = (): void => dispatch({ type: 'dialog/closed' })
  // Before the early return below: a hook may not sit behind a conditional.
  useEscapeKey(close)
  const fail = useToastError()

  // Deleted from under the dialog: nothing left to add to, so it gets out of the way.
  useEffect(() => {
    if (playlist === null) dispatch({ type: 'dialog/closed' })
  }, [playlist, dispatch])

  const matches = useMemo(() => filterSongs(songs, query), [songs, query])

  if (!playlist) return null

  const held = new Set(playlist.songIds)
  // Outside the `matches` memo on purpose: `held` turns over on every `playlists/upserted`.
  const offered = matches.filter((song) => !held.has(song.id))

  function add(songId: string): void {
    void window.api.playlists
      .addSong(playlistId, songId)
      .then((updated) => dispatch({ type: 'playlists/upserted', playlist: updated }))
      .catch(fail)
  }

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog add-to-playlist"
        role="dialog"
        aria-modal="true"
        aria-label={`Add to ${playlist.name}`}
      >
        <div className="dialog-head">
          <h2>Add to {playlist.name}</h2>
          <button type="button" className="dialog-close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>

        <input
          type="search"
          className="pill-search"
          aria-label="Search songs to add"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {offered.length === 0 ? (
          // Four ways to have nothing to offer: search vs playlist, and whether a search was run.
          <p className="dialog-hint">
            {matches.length > 0
              ? query.trim() === ''
                ? 'Every song is already in this playlist.'
                : 'Every match is already in this playlist.'
              : query.trim() === ''
                ? 'No songs in your library yet.'
                : 'No songs match your search.'}
          </p>
        ) : (
          <ul className="add-list">
            {offered.map((song) => (
              <li key={song.id} className="add-row">
                <span className="add-row-main">
                  <span className="add-title">{song.title}</span>
                  <span className="add-sub">{formatDuration(song.durationSec)}</span>
                </span>
                <button
                  type="button"
                  className="add-button"
                  aria-label={`Add ${song.title} to ${playlist.name}`}
                  onClick={() => add(song.id)}
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
