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

/** Keyboard-reachable items in draw order; module scope keeps the layout effect free of a dependency. */
function menuItemsIn(popup: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(
    popup?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []
  )
}

export interface SongRowProps {
  song: SongDto
  isCurrent: boolean
  tags: Tag[]
  containingPlaylist: Playlist | null
  /** Whether this row may START a reorder drag — Custom Order with nothing filtered away. */
  draggable: boolean
  /** True only while the list is running one of its own drags. */
  dragActive: boolean
  dropEdge: 'before' | 'after' | null
  onPlay(songId: string): void
  onEdit(songId: string): void
  onDelete(songId: string): void
  onToggleTag(songId: string, tagName: string): void
  onRemoveFromPlaylist(playlistId: string, songId: string): void
  onDragStart(songId: string): void
  onDragOver(songId: string, edge: 'before' | 'after'): void
  onDrop(): void
  onDragEnd(): void
}

/** One row. Memoised: the list re-renders on every library change while the rows almost never move. */
function SongRowView({
  song,
  isCurrent,
  tags,
  containingPlaylist,
  draggable,
  dragActive,
  dropEdge,
  onPlay,
  onEdit,
  onDelete,
  onToggleTag,
  onRemoveFromPlaylist,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: SongRowProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [flipUp, setFlipUp] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  /** Where the popup hangs and what the keyboard lands on, both settled before the first paint. */
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
    // `preventScroll`: the flip class is unpainted, so the popup is still at the wrong geometry.
    menuItemsIn(popupRef.current)[0]?.focus({ preventScroll: true })
  }, [menuOpen])

  /** Bound only while the menu is up, not via `useEscapeKey`: a listener per row would swallow every dialog's Escape. */
  useEffect(() => {
    if (!menuOpen) return

    // No `preventDefault`, unlike the dialogs': a menu's Escape reaches no further than closing itself.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setMenuOpen(false)
      setTagsOpen(false)
      // Escape only: an outside click has already chosen where the user is going.
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

  /** The items are out of the tab order, so this is the only way through the menu from the keyboard. */
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
    <li
      className={`song-row${isCurrent ? ' is-current' : ''}${dropEdge ? ` drop-${dropEdge}` : ''}`}
      // An open menu is buttons all the way down: none may double as a drag handle, or a drifted
      // press on Delete becomes a reorder.
      draggable={draggable && !menuOpen}
      onDragStart={(event) => {
        if (!draggable || menuOpen) return
        // No setData: the drop path reads a ref, and a text/plain payload would only feed our own inputs.
        event.dataTransfer.effectAllowed = 'move'
        onDragStart(song.id)
      }}
      // A drag is ours only between our own dragStart and dragEnd; the `dragActive` guards leave
      // every other drag completely alone.
      onDragOver={(event) => {
        if (!dragActive) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        onDragOver(song.id, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        event.stopPropagation()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <span className="song-duration">{formatDuration(song.durationSec)}</span>
      <button
        type="button"
        className="song-title"
        disabled={!song.exists}
        aria-current={isCurrent ? 'true' : undefined}
        // The row keeps focus after a click, and space there means pause; `useKeyboardShortcuts` reads this.
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
            // A song may carry a tag the registry never heard of — it still shows, in the stylesheet's grey.
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

/** The whole registry, ticked where this song carries it; creating tags is the Tags dialog's job alone. */
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
            <span className="menu-check" aria-hidden="true">
              {has ? '✓' : ''}
            </span>
            <TagChip name={tag.name} color={tag.color} className="menu-tag-chip" />
          </button>
        )
      })}
    </>
  )
}

export const SongRow = memo(SongRowView)
