import { useEffect, useRef } from 'react'

/**
 * The app's global keys: space for play/pause, `m` for mute, ←/→ to skip. Bound to `document`
 * because focus is rarely on the player bar, and read through a ref so the listener registers once
 * while still seeing the current callbacks.
 */

/** How far one arrow press moves the song, in seconds. */
const SEEK_STEP_SEC = 10

export interface KeyboardShortcutsOptions {
  /** False disables everything (a dialog is open). */
  enabled: boolean
  hasCurrentSong: boolean
  onTogglePlay(): void
  onToggleMute(): void
  onSeekBy(delta: number): void
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Space already activates these, so they keep the key unless they opt out via `data-space-transport`. */
const SPACE_ACTIVATED_TAGS = new Set(['BUTTON', 'A'])

function tagOf(target: EventTarget | null): string | null {
  return target instanceof HTMLElement ? target.tagName : null
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable
}

export function useKeyboardShortcuts(options: KeyboardShortcutsOptions): void {
  const latest = useRef(options)

  useEffect(() => {
    latest.current = options
  }, [options])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A held key would otherwise stutter play/pause dozens of times a second.
      if (event.repeat) return

      // A modifier means the OS or the chrome, not the transport (⌘M is Minimize); Shift types `M`.
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const { enabled, hasCurrentSong, onTogglePlay, onToggleMute, onSeekBy } = latest.current
      if (!enabled || isTyping(event.target)) return

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // The row menu's arrow navigation runs first and marks the event; a menu must not scrub.
        if (event.defaultPrevented) return
        const target = event.target instanceof HTMLElement ? event.target : null
        if (target?.closest('[role="menu"]') != null) return
        if (!hasCurrentSong) return
        event.preventDefault()
        onSeekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_SEC : SEEK_STEP_SEC)
        return
      }

      if (event.key === ' ') {
        const target = event.target instanceof HTMLElement ? event.target : null
        // Rows opt back in via `data-space-transport`; the preventDefault below also cancels the
        // button's native keyup click, not just the page scroll.
        const optedIn = target?.closest('[data-space-transport]') != null
        if (!optedIn && SPACE_ACTIVATED_TAGS.has(tagOf(event.target) ?? '')) return
        // Not a cold start: space resumes what is cued, it does not choose a song.
        if (!hasCurrentSong) return
        event.preventDefault()
        onTogglePlay()
        return
      }

      if (event.key === 'm' || event.key === 'M') onToggleMute()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
