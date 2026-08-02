import { useCallback, useMemo, type ReactElement } from 'react'
import type { Playlist, SongDto } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { filterSongs } from '../lib/search'
import { useAppDispatch, useAppState } from '../state/AppContext'
import type { AppState, View } from '../state/appReducer'
import { SongRow } from './SongRow'

/** The playlist being viewed, or null in the Library view. */
function viewedPlaylist(view: View, playlists: Playlist[]): Playlist | null {
  if (view.kind === 'library') return null
  return playlists.find((playlist) => playlist.id === view.id) ?? null
}

/**
 * The songs the current view is about, in the view's own order.
 *
 * A playlist may still reference a song that was deleted between two reads, so unknown ids are
 * dropped rather than rendered as holes.
 */
function songsInView(songs: SongDto[], playlist: Playlist | null, view: View): SongDto[] {
  if (view.kind === 'library') return songs
  if (!playlist) return []
  const byId = new Map(songs.map((song) => [song.id, song]))
  return playlist.songIds.flatMap((id) => {
    const song = byId.get(id)
    return song ? [song] : []
  })
}

export function SongList(): ReactElement {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { songs, playlists, query, view, playback } = state

  const containingPlaylist = useMemo(() => viewedPlaylist(view, playlists), [view, playlists])
  const inView = useMemo(
    () => songsInView(songs, containingPlaylist, view),
    [songs, containingPlaylist, view]
  )
  // The search filters what is SHOWN, never the queue: clicking a filtered row still plays inside
  // the full queue order.
  const visible = useMemo(() => filterSongs(inView, query), [inView, query])

  const fail = useCallback(
    (error: unknown) => dispatch({ type: 'toast/pushed', message: errorMessage(error) }),
    [dispatch]
  )

  const onPlay = useCallback(
    (songId: string) => dispatch({ type: 'song/selected', songId }),
    [dispatch]
  )

  const onEdit = useCallback(
    (songId: string) => dispatch({ type: 'dialog/opened', dialog: { kind: 'edit', songId } }),
    [dispatch]
  )

  const onDelete = useCallback(
    (songId: string) => {
      const song = songs.find((entry) => entry.id === songId)
      dispatch({
        type: 'dialog/opened',
        dialog: {
          kind: 'confirm',
          message: `Move "${song?.title ?? songId}" to the trash?`,
          confirmLabel: 'Delete',
          intent: { kind: 'deleteSong', songId }
        }
      })
    },
    [dispatch, songs]
  )

  const onReveal = useCallback(
    (songId: string) => {
      void window.api.library.revealInFolder(songId).catch(fail)
    },
    [fail]
  )

  const onAddToPlaylist = useCallback(
    (playlistId: string, songId: string) => {
      void window.api.playlists
        .addSong(playlistId, songId)
        .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
        .catch(fail)
    },
    [dispatch, fail]
  )

  const onRemoveFromPlaylist = useCallback(
    (playlistId: string, songId: string) => {
      void window.api.playlists
        .removeSong(playlistId, songId)
        .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
        .catch(fail)
    },
    [dispatch, fail]
  )

  if (visible.length === 0) {
    return <p className="empty-state">{emptyMessage(state)}</p>
  }

  return (
    <ul className="song-list" aria-label="Songs">
      {visible.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          isCurrent={song.id === playback.currentId}
          playlists={playlists}
          containingPlaylist={containingPlaylist}
          onPlay={onPlay}
          onEdit={onEdit}
          onDelete={onDelete}
          onReveal={onReveal}
          onAddToPlaylist={onAddToPlaylist}
          onRemoveFromPlaylist={onRemoveFromPlaylist}
        />
      ))}
    </ul>
  )
}

function emptyMessage(state: AppState): string {
  if (state.query.trim() !== '') return 'No songs match your search.'
  if (state.view.kind === 'playlist') return 'This playlist is empty.'
  return 'No songs yet. Add one to get started.'
}
