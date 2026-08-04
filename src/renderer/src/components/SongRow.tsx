import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Playlist, SongDto, Tag } from '../../../shared/types'
import { formatBytes, formatDuration, readableTextColor } from '../lib/format'

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
  const menuRef = useRef<HTMLDivElement>(null)

  /**
   * Registered only while the menu is up. `useEscapeKey` is deliberately not used: it binds for the
   * life of the component, and a listener per row — hundreds of them, all calling `preventDefault`
   * — would swallow the Escape every dialog in the app depends on.
   */
  useEffect(() => {
    if (!menuOpen) return

    // Deliberately does NOT `preventDefault`, unlike the dialogs': this menu is not modal, and a
    // dialog can legitimately be open behind it (a file dropped on the window while it was up).
    // Swallowing the key there would take two presses to get out of one Escape's worth of trouble.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setMenuOpen(false)
      setTagsOpen(false)
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
            return (
              <span
                key={name}
                className="song-tag"
                style={
                  known
                    ? { background: known.color, color: readableTextColor(known.color) }
                    : undefined
                }
              >
                {name}
              </span>
            )
          })}
        </span>
      )}
      <span className="song-size">{formatBytes(song.sizeBytes)}</span>

      <div className="song-menu" ref={menuRef}>
        <button
          type="button"
          className="song-menu-button"
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
          <div className="song-menu-popup" role="menu">
            <button
              type="button"
              role="menuitem"
              aria-expanded={tagsOpen}
              onClick={() => setTagsOpen((open) => !open)}
            >
              Tags
            </button>
            {tagsOpen ? <TagItems song={song} tags={tags} onToggleTag={onToggleTag} /> : null}

            <button type="button" role="menuitem" onClick={() => act(() => onEdit(song.id))}>
              Edit
            </button>
            {containingPlaylist ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => act(() => onRemoveFromPlaylist(containingPlaylist.id, song.id))}
              >
                Remove from &quot;{containingPlaylist.name}&quot;
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
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
      <button type="button" role="menuitem" className="menu-note" disabled>
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
            aria-checked={has}
            className="menu-check-item"
            onClick={() => onToggleTag(song.id, tag.name)}
          >
            {/* Hidden from the name, so the item is addressable by the tag itself. */}
            <span className="menu-check" aria-hidden="true">
              {has ? '✓' : ''}
            </span>
            {tag.name}
          </button>
        )
      })}
    </>
  )
}

export const SongRow = memo(SongRowView)
