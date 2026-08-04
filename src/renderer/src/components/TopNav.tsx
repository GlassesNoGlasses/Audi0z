import { useMemo, type ReactElement } from 'react'
import { songsInView, viewedPlaylist } from '../lib/viewSongs'
import { defaultRng } from '../playback/engine'
import { LIBRARY_QUEUE_ID, type Rng } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'
import { SearchBox } from './SearchBox'

export interface TopNavProps {
  /** Picks which song a shuffled view starts on. Injected by the tests, `Math.random` in the app. */
  rng?: Rng
}

/**
 * The bar above the song list: play the view, search it, add to it, and the two dialogs that are
 * not about a single song.
 */
export function TopNav({ rng = defaultRng }: TopNavProps): ReactElement {
  const { songs, playlists, settings, view } = useAppState()
  const dispatch = useAppDispatch()

  const containingPlaylist = useMemo(() => viewedPlaylist(view, playlists), [view, playlists])
  const inView = useMemo(
    () => songsInView(songs, containingPlaylist, view),
    [songs, containingPlaylist, view]
  )

  // A playlist that has just been deleted leaves the view pointing at nothing for a render; the
  // button is disabled anyway, so the name only has to stay distinct from the transport's "Play".
  const viewName = view.kind === 'library' ? 'Library' : (containingPlaylist?.name ?? 'playlist')

  /**
   * Playing the view hands the queue over to it, exactly as playing one of its rows does — with
   * the view's own shuffle and repeat, and starting where shuffle says rather than always at the
   * top. The search is not consulted: it filters what is shown, never what is queued.
   */
  function playView(): void {
    const ids = inView.map((song) => song.id)
    if (ids.length === 0) return
    const shuffle = containingPlaylist ? containingPlaylist.shuffle : settings.libraryShuffle
    dispatch({
      type: 'queue/selected',
      queueId: view.kind === 'library' ? LIBRARY_QUEUE_ID : view.id,
      order: ids,
      shuffle,
      repeat: containingPlaylist ? containingPlaylist.repeat : settings.libraryRepeat,
      startSongId: shuffle ? ids[rng(ids.length)] : ids[0]
    })
  }

  return (
    <header className="topnav">
      <button
        type="button"
        className="topnav-play"
        aria-label={`Play ${viewName}`}
        disabled={inView.length === 0}
        onClick={playView}
      >
        ▶
      </button>

      <SearchBox />

      {view.kind === 'playlist' && containingPlaylist ? (
        <button
          type="button"
          // Distinct from the download button's "Add song", which adds to the library itself.
          aria-label={`Add songs to ${containingPlaylist.name}`}
          onClick={() =>
            dispatch({
              type: 'dialog/opened',
              dialog: { kind: 'addToPlaylist', playlistId: containingPlaylist.id }
            })
          }
        >
          Add Song
        </button>
      ) : null}

      <span className="topnav-spacer" />

      <button
        type="button"
        className="topnav-icon"
        // The label the tests, the e2e suite and a screen reader have always known this by.
        aria-label="Add song"
        onClick={() =>
          dispatch({
            type: 'dialog/opened',
            dialog: { kind: 'add', source: { kind: 'files', paths: [] } }
          })
        }
      >
        <DownloadIcon />
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: 'dialog/opened', dialog: { kind: 'tags' } })}
      >
        Tags
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: 'dialog/opened', dialog: { kind: 'settings' } })}
      >
        Settings
      </button>
    </header>
  )
}

/** Inline rather than an emoji: a glyph the button's own `color` can tint. */
function DownloadIcon(): ReactElement {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5v8" />
      <path d="M4.5 6.5 8 10l3.5-3.5" />
      <path d="M2.5 11.5v2h11v-2" />
    </svg>
  )
}
