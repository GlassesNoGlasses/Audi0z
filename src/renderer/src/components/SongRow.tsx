import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import type { Playlist, SongDto, Tag } from '../../../shared/types'
import { formatBytes, formatDate, formatDuration } from '../lib/format'
import { TagChip } from './TagChip'

/**
 * The items the keyboard can reach, in the order they are drawn: the tag toggles the Tags submenu
 * adds are in, the disabled empty-registry note is out. Module scope, so the layout effect below
 * can walk the menu without taking a new dependency on every render.
 */
function menuItemsIn(popup: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(
    popup?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []
  )
}

export interface SongRowProps {
  song: SongDto
  isCurrent: boolean
  /** The registry: the colour each chip is drawn in, and everything the menu can put on a song. */
  tags: Tag[]
  /** The playlist this row is being viewed inside, if any — the only place it can be removed from one. */
  containingPlaylist: Playlist | null
  onPlay(songId: string): void
  onEdit(songId: string): void
  onDelete(songId: string): void
  onToggleTag(songId: string, tagName: string): void
  onRemoveFromPlaylist(playlistId: string, songId: string): void
}

/**
 * One row: playing time and title on the left, size and an overflow menu on the right.
 *
 * Everything that is not "play this" lives behind the ⋯ menu — a row that carried a button per
 * action was a wall of controls, and the ones it carried (reveal, add-to-playlist) now have better
 * homes in Settings and the add-to-playlist dialog.
 *
 * Memoised because the list re-renders on every library change while the rows themselves almost
 * never move — which keeps a thousand-song library cheap.
 */
function SongRowView({
  song,
  isCurrent,
  tags,
  containingPlaylist,
  onPlay,
  onEdit,
  onDelete,
  onToggleTag,
  onRemoveFromPlaylist
}: SongRowProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [flipUp, setFlipUp] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  /**
   * Where the popup hangs, and what the keyboard lands on — both settled before the first paint,
   * so the menu is never seen in the wrong place or with nothing focused.
   */
  useLayoutEffect(() => {
    if (!menuOpen) {
      setFlipUp(false)
      return
    }
    const wrapper = menuRef.current
    const popup = popupRef.current
    if (wrapper && popup) {
      const bounds = (
        wrapper.closest('.song-list') ?? document.documentElement
      ).getBoundingClientRect()
      const anchor = wrapper.getBoundingClientRect()
      const height = popup.getBoundingClientRect().height
      // Flip only when down overflows AND up actually fits — a menu taller than both stays down.
      setFlipUp(anchor.bottom + height > bounds.bottom && anchor.top - height >= bounds.top)
    }
    // `preventScroll`: the flip class has not been painted yet, so the popup is still sitting at
    // the geometry the line above just decided is wrong. Scrolling the list to it is never right.
    menuItemsIn(popupRef.current)[0]?.focus({ preventScroll: true })
  }, [menuOpen])

  /**
   * Registered only while the menu is up. `useEscapeKey` is deliberately not used: it binds for the
   * life of the component, and a listener per row — hundreds of them, all calling `preventDefault`
   * — would swallow the Escape every dialog in the app depends on.
   */
  useEffect(() => {
    if (!menuOpen) return

    // Deliberately does NOT `preventDefault`, unlike the dialogs': a modal's Escape is a claim on
    // the whole app, a menu's reaches no further than closing itself, and swallowing it would cost
    // a second press to anything that ever sits behind this menu.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setMenuOpen(false)
      setTagsOpen(false)
      // Escape only. An outside click has already chosen where the user is going, and dragging
      // focus back to a button they just left would undo their own gesture.
      triggerRef.current?.focus()
    }
    // `mousedown` rather than `click`: the menu has to be gone before whatever was clicked reacts.
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
      setTagsOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [menuOpen])

  /**
   * The arrow keys walk the items and wrap round the ends; Home/End jump to them. The items are
   * out of the tab order, so this is the only way through the menu from the keyboard.
   */
  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const items = menuItemsIn(popupRef.current)
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (at: number): void =>
      items[((at % items.length) + items.length) % items.length]?.focus()

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    }
  }

  /** Every item but the tag toggles is a one-shot: it acts and the menu is done. */
  function act(run: () => void): void {
    setMenuOpen(false)
    setTagsOpen(false)
    run()
  }

  return (
    <li className={`song-row${isCurrent ? ' is-current' : ''}`}>
      <span className="song-duration">{formatDuration(song.durationSec)}</span>
      <button
        type="button"
        className="song-title"
        // A song whose file has gone has nothing to play, so the whole row is inert.
        disabled={!song.exists}
        aria-current={isCurrent ? 'true' : undefined}
        // The row keeps focus after a click, and space there means pause, not play this again.
        // `useKeyboardShortcuts` reads the attribute; Enter is untouched, so the row is still
        // reachable and activatable from the keyboard alone.
        data-space-transport=""
        onClick={() => onPlay(song.id)}
      >
        {song.title}
      </button>
      {song.exists ? null : <span className="song-missing">File missing</span>}
      {/* Nothing at all rather than an empty box: a flex gap either side of it is a gap for good. */}
      {song.tags.length === 0 ? null : (
        <span className="song-tags">
          {song.tags.map((name) => {
            // A song may carry a tag the registry has never heard of (hand-edited JSON, or a tag
            // deleted between two reads) — it still shows, in the stylesheet's grey.
            const known = tags.find((tag) => tag.name === name)
            return <TagChip key={name} name={name} color={known?.color} className="song-tag" />
          })}
        </span>
      )}
      <span className="song-added">{formatDate(song.addedAt)}</span>
      <span className="song-size">{formatBytes(song.sizeBytes)}</span>

      <div className="song-menu" ref={menuRef}>
        <button
          type="button"
          className="song-menu-button"
          ref={triggerRef}
          aria-label={`Options for ${song.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((open) => !open)
            setTagsOpen(false)
          }}
        >
          …
        </button>

        {menuOpen ? (
          <div
            className={`song-menu-popup${flipUp ? ' song-menu-popup--up' : ''}`}
            role="menu"
            aria-label={`Options for ${song.title}`}
            ref={popupRef}
            onKeyDown={onMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-expanded={tagsOpen}
              onClick={() => setTagsOpen((open) => !open)}
            >
              Tags
            </button>
            {tagsOpen ? <TagItems song={song} tags={tags} onToggleTag={onToggleTag} /> : null}

            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => act(() => onEdit(song.id))}
            >
              Edit
            </button>
            {containingPlaylist ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => act(() => onRemoveFromPlaylist(containingPlaylist.id, song.id))}
              >
                Remove from &quot;{containingPlaylist.name}&quot;
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="danger"
              onClick={() => act(() => onDelete(song.id))}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </li>
  )
}

interface TagItemsProps {
  song: SongDto
  tags: Tag[]
  onToggleTag(songId: string, tagName: string): void
}

/**
 * The whole registry, ticked where this song carries it. The list is of tags that EXIST — creating
 * one is the Tags dialog's job alone, so an empty registry has nothing to offer but the way there.
 */
function TagItems({ song, tags, onToggleTag }: TagItemsProps): ReactElement {
  if (tags.length === 0) {
    return (
      <button type="button" role="menuitem" tabIndex={-1} className="menu-note" disabled>
        No tags yet — create them from Tags.
      </button>
    )
  }

  return (
    <>
      {tags.map((tag) => {
        const has = song.tags.includes(tag.name)
        return (
          <button
            key={tag.id}
            type="button"
            role="menuitemcheckbox"
            tabIndex={-1}
            aria-checked={has}
            className="menu-check-item"
            onClick={() => onToggleTag(song.id, tag.name)}
          >
            {/* Hidden from the name, so the item is addressable by the tag itself. */}
            <span className="menu-check" aria-hidden="true">
              {has ? '✓' : ''}
            </span>
            {/*
             * The chip is the item's only visible text, so the button's accessible name is still
             * the tag name alone. Everything in the registry has a colour, so the menu never draws
             * the chip's uncoloured fallback.
             */}
            <TagChip name={tag.name} color={tag.color} className="menu-tag-chip" />
          </button>
        )
      })}
    </>
  )
}

export const SongRow = memo(SongRowView)
