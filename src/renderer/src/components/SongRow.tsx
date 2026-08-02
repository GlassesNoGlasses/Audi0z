import { memo, type ReactElement } from 'react'
import type { Playlist, SongDto } from '../../../shared/types'

export interface SongRowProps {
  song: SongDto
  isCurrent: boolean
  playlists: Playlist[]
  /** The playlist this row is being viewed inside, if any — the only place it can be removed from one. */
  containingPlaylist: Playlist | null
  onPlay(songId: string): void
  onEdit(songId: string): void
  onDelete(songId: string): void
  onReveal(songId: string): void
  onAddToPlaylist(playlistId: string, songId: string): void
  onRemoveFromPlaylist(playlistId: string, songId: string): void
}

/**
 * One row. Memoised because the list re-renders on every library change while the rows themselves
 * almost never move — which keeps a thousand-song library cheap.
 */
function SongRowView({
  song,
  isCurrent,
  playlists,
  containingPlaylist,
  onPlay,
  onEdit,
  onDelete,
  onReveal,
  onAddToPlaylist,
  onRemoveFromPlaylist
}: SongRowProps): ReactElement {
  return (
    <li className={`song-row${isCurrent ? ' is-current' : ''}`}>
      <button
        type="button"
        className="song-title"
        // A song whose file has gone has nothing to play, so the whole row is inert.
        disabled={!song.exists}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onPlay(song.id)}
      >
        {song.title}
      </button>
      {song.exists ? null : <span className="song-missing">File missing</span>}
      <span className="song-tags">{song.tags.join(', ')}</span>
      <select
        className="song-playlists"
        aria-label={`Add ${song.title} to a playlist`}
        value=""
        disabled={playlists.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onAddToPlaylist(event.target.value, song.id)
        }}
      >
        <option value="">Add to playlist…</option>
        {playlists.map((playlist) => (
          <option key={playlist.id} value={playlist.id}>
            {playlist.name}
          </option>
        ))}
      </select>
      {containingPlaylist ? (
        <button
          type="button"
          aria-label={`Remove ${song.title} from ${containingPlaylist.name}`}
          onClick={() => onRemoveFromPlaylist(containingPlaylist.id, song.id)}
        >
          Remove
        </button>
      ) : null}
      <button type="button" aria-label={`Edit ${song.title}`} onClick={() => onEdit(song.id)}>
        Edit
      </button>
      <button type="button" aria-label={`Reveal ${song.title}`} onClick={() => onReveal(song.id)}>
        Reveal
      </button>
      <button type="button" aria-label={`Delete ${song.title}`} onClick={() => onDelete(song.id)}>
        Delete
      </button>
    </li>
  )
}

export const SongRow = memo(SongRowView)
