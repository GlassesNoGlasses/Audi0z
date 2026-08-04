import type { Playlist, SongDto } from '../../../shared/types'
import type { View } from '../state/appReducer'

/**
 * What the current view is about.
 *
 * Shared rather than owned by `SongList`: the top bar's play button has to queue exactly the songs
 * the list is showing, and two answers to "which songs are in view" would eventually disagree.
 */

/** The playlist being viewed, or null in the Library view. */
export function viewedPlaylist(view: View, playlists: Playlist[]): Playlist | null {
  if (view.kind === 'library') return null
  return playlists.find((playlist) => playlist.id === view.id) ?? null
}

/**
 * The songs the current view is about, in the view's own order.
 *
 * A playlist may still reference a song that was deleted between two reads, so unknown ids are
 * dropped rather than rendered as holes.
 */
export function songsInView(songs: SongDto[], playlist: Playlist | null, view: View): SongDto[] {
  if (view.kind === 'library') return songs
  if (!playlist) return []
  const byId = new Map(songs.map((song) => [song.id, song]))
  return playlist.songIds.flatMap((id) => {
    const song = byId.get(id)
    return song ? [song] : []
  })
}
