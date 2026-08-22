import type { Playlist, SongDto } from '../../../shared/types'
import { SortDirection, SortType, type SortMode, type View } from '../state/appReducer'

/**
 * What the current view is about, and in what order.
 *
 * Shared rather than owned by `SongList`: the top bar's play button has to queue exactly the songs
 * the list is showing, and two answers to "which songs are in view" would eventually disagree.
 *
 * The order is part of that answer, which is why the sort lives here too: the list, the play
 * button and `App`'s queue re-sync all order through `songsInView` or `sortSongs` and nowhere
 * else, so a sorted view is a sorted queue rather than a list that disagrees with what plays next.
 */

/** The playlist being viewed, or null in the Library view. */
export function viewedPlaylist(view: View, playlists: Playlist[]): Playlist | null {
  if (view.kind === 'library') return null
  return playlists.find((playlist) => playlist.id === view.id) ?? null
}

/**
 * A copy of the songs in the order the sort asks for, or the list itself when there is no sort —
 * the identity is what lets the callers' memos treat "no sort" as costing nothing.
 *
 * `sort` is stable, so songs the comparator cannot separate (two added in the same millisecond)
 * stay in the order they arrived in.
 */
export function sortSongs(songs: SongDto[], sort: SortMode): SongDto[] {
  const { type, direction } = sort
  if (type === SortType.CUSTOM) return songs

  const flip = direction === SortDirection.ASC ? 1 : -1
 return [...songs].sort((a, b) => {
    switch (type) {
      case SortType.DATEADDED:
        return a.addedAt < b.addedAt ? -flip : a.addedAt > b.addedAt ? flip : 0
      case SortType.TITLE:
        return (
          a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) * flip
        )
      case SortType.DURATION:
        if (a.durationSec === undefined) return b.durationSec === undefined ? 0 : 1
        if (b.durationSec === undefined) return -1
        return (a.durationSec - b.durationSec) * flip
      case SortType.SIZE:
        if (a.sizeBytes === null) return b.sizeBytes === null ? 0 : 1
        if (b.sizeBytes === null) return -1
        return (a.sizeBytes - b.sizeBytes) * flip
    }
  })
}

/**
 * The full stored order after a drag of its resolvable part: known ids take the dragged order,
 * unknown ids keep their stored positions — so one orphaned reference (a song deleted while a
 * playlist still names it) cannot wedge every reorder of that playlist.
 */
export function mergeReorderedIds(
  storedIds: readonly string[],
  reorderedKnownIds: readonly string[],
  knownIds: ReadonlySet<string>
): string[] {
  let cursor = 0
  return storedIds.map((id) => (knownIds.has(id) ? (reorderedKnownIds[cursor++] ?? id) : id))
}

/**
 * The songs the current view is about, in the sort's order or — with no sort — the view's own.
 *
 * A playlist may still reference a song that was deleted between two reads, so unknown ids are
 * dropped rather than rendered as holes.
 */
export function songsInView(
  songs: SongDto[],
  playlist: Playlist | null,
  view: View,
  sort: SortMode
): SongDto[] {
  if (view.kind === 'library') return sortSongs(songs, sort)
  if (!playlist) return []
  const byId = new Map(songs.map((song) => [song.id, song]))
  const picked = playlist.songIds.flatMap((id) => {
    const song = byId.get(id)
    return song ? [song] : []
  })
  return sortSongs(picked, sort)
}
