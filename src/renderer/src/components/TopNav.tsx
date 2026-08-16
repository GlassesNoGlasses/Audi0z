import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { songsInView, viewedPlaylist } from '../lib/viewSongs'
import { defaultRng } from '../playback/engine'
import { LIBRARY_QUEUE_ID, type Rng } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'
import type { SortMode } from '../state/appReducer'
import { SearchBox } from './SearchBox'

/** What the menu can order by. Null is not one of them: it is the stored order, listed as Manual. */
type SortField = NonNullable<SortMode>['field']

export interface TopNavProps {
  /** Picks which song a shuffled view starts on. Injected by the tests, `Math.random` in the app. */
  rng?: Rng
}

/**
 * The bar above the song list: play the view, search it, add to it, and the two dialogs that are
 * not about a single song.
 */
export function TopNav({ rng = defaultRng }: TopNavProps): ReactElement {
  const { songs, playback, playlists, settings, sort, view } = useAppState()
  const dispatch = useAppDispatch()

  const containingPlaylist = useMemo(() => viewedPlaylist(view, playlists), [view, playlists])
  const inView = useMemo(
    () => songsInView(songs, containingPlaylist, view, sort),
    [songs, containingPlaylist, view, sort]
  )

  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)

  /**
   * Registered only while the menu is up, exactly as the row menu's is, and deliberately without
   * `preventDefault`: this menu is not modal, a dialog can be open behind it (a file dropped on
   * the window while it was up), and swallowing the key would cost two presses to leave one menu.
   */
  useEffect(() => {
    if (!sortOpen) return

    // The keyboard's way in — and load-bearing beyond that: the trigger is a SIBLING of the menu,
    // so an arrow pressed with focus still on it reads as outside the menu to the global shortcuts
    // and seeks the song behind it. Focusing an item puts the press inside `[role="menu"]`, which
    // is where that guard looks. `preventScroll`, as the row menu's is: the bar never scrolls.
    sortRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus({
      preventScroll: true
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setSortOpen(false)
      // Escape only. An outside click has already chosen where the user is going.
      sortTriggerRef.current?.focus()
    }
    // `mousedown` rather than `click`: the menu has to be gone before whatever was clicked reacts.
    const onPointerDown = (event: MouseEvent): void => {
      if (sortRef.current?.contains(event.target as Node)) return
      setSortOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [sortOpen])

  // A playlist that has just been deleted leaves the view pointing at nothing for a render; the
  // button is disabled anyway, so the name only has to stay distinct from the transport's own
  // "Play" and "Pause" — which the view name suffix does.
  const viewName = view.kind === 'library' ? 'Library' : (containingPlaylist?.name ?? 'playlist')

  const viewQueueId = view.kind === 'library' ? LIBRARY_QUEUE_ID : view.id
  // The button is a toggle exactly when this view's queue is the one loaded in the transport.
  const viewIsCued = playback.queueId === viewQueueId && playback.currentId !== null
  const viewPlaying = viewIsCued && playback.isPlaying

  /**
   * Playing the view hands the queue over to it, exactly as playing one of its rows does — with
   * the view's own shuffle and repeat, and starting where shuffle says rather than always at the
   * top. The search is not consulted: it filters what is shown, never what is queued.
   *
   * Once the view is the queue, handing it over again would throw away what the listener is in the
   * middle of — back to song one (or a fresh shuffle pick), history and played flags gone — so the
   * button becomes the transport's play/pause instead.
   */
  function playView(): void {
    if (viewIsCued) {
      dispatch({ type: 'transport/togglePlay' })
      return
    }

    const ids = inView.map((song) => song.id)
    if (ids.length === 0) return
    const shuffle = containingPlaylist ? containingPlaylist.shuffle : settings.libraryShuffle
    dispatch({
      type: 'queue/selected',
      queueId: viewQueueId,
      order: ids,
      shuffle,
      repeat: containingPlaylist ? containingPlaylist.repeat : settings.libraryRepeat,
      startSongId: shuffle ? ids[rng(ids.length)] : ids[0]
    })
  }

  /**
   * A field is asked for ascending the first time — oldest first, shortest first — and the next
   * press on the one already in force flips it. Manual hands the view back to its stored order.
   * Every choice shuts the menu: it is a radio group, not somewhere to stay.
   */
  function choose(field: SortField | null): void {
    setSortOpen(false)
    dispatch({
      type: 'sort/changed',
      sort:
        field === null
          ? null
          : { field, direction: sort?.field === field && sort.direction === 'asc' ? 'desc' : 'asc' }
    })
  }

  function chosenSortVisual(sort: SortMode, target: SortField): string {
    if (sort?.field != target) {
      return ''
    }
    return sort.direction === 'asc' ? '↓' : '↑'
  }

  return (
    <header className="topnav">
      <button
        type="button"
        className="topnav-play"
        aria-label={viewPlaying ? `Pause ${viewName}` : `Play ${viewName}`}
        disabled={inView.length === 0}
        onClick={playView}
      >
        {viewPlaying ? '⏸' : '▶'}
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

      <div className="sort-menu-anchor" ref={sortRef}>
        <button
          type="button"
          className="topnav-icon"
          ref={sortTriggerRef}
          aria-label="Sort songs"
          aria-haspopup="menu"
          aria-expanded={sortOpen}
          onClick={() => setSortOpen((open) => !open)}
        >
          <SortIcon />
        </button>
        {sortOpen ? (
          <div className="sort-menu" role="menu" aria-label="Sort songs">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={sort === null}
              onClick={() => choose(null)}
            >
              Manual order
            </button>
            {/* The arrow is part of the name on purpose: `aria-checked` says which mode is on,
                and nothing else would say which way round it runs. */}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={sort?.field === 'addedAt'}
              onClick={() => choose('addedAt')}
            >
              {chosenSortVisual(sort, 'addedAt')} Date added
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={sort?.field === 'durationSec'}
              onClick={() => choose('durationSec')}
            >
              {chosenSortVisual(sort, 'durationSec')} Duration
            </button>
          </div>
        ) : null}
      </div>

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

/** Shortening bars: the shape a sorted list makes, and the one every other app draws this with. */
function SortIcon(): ReactElement {
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
      <path d="M2.5 4h11" />
      <path d="M2.5 8h7" />
      <path d="M2.5 12h3.5" />
    </svg>
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
