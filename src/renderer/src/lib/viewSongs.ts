import type { Playlist, SongDto } from '../../../shared/types'
import { SortDirection, SortType, type SortMode, type View } from '../state/appReducer'

/**
 * What the current view is about, and in what order — one answer, so the list, the top bar's play
 * button and `App`'s queue re-sync cannot disagree about what is in view or what plays next.
 */

/** The playlist being viewed, or null in the Library view. */
export function viewedPlaylist(view: View, playlists: Playlist[]): Playlist | null {
  if (view.kind === 'library') return null
  return playlists.find((playlist) => playlist.id === view.id) ?? null
}

/**
 * A copy in the sort's order, or the list itself under Custom Order — that identity is what keeps
 * the callers' memos cheap. `sort` is stable, so ties keep the order they arrived in.
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

/** Known ids take the dragged order, unknown ids keep their slots, so an orphan can't wedge reorders. */
export function mergeReorderedIds(
  storedIds: readonly string[],
  reorderedKnownIds: readonly string[],
  knownIds: ReadonlySet<string>
): string[] {
  let cursor = 0
  return storedIds.map((id) => (knownIds.has(id) ? (reorderedKnownIds[cursor++] ?? id) : id))
}

/** The view's songs in the sort's order; ids a playlist still names but the library lost are dropped. */
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
