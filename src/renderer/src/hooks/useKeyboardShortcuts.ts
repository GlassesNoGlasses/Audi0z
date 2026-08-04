import { useEffect, useRef } from 'react'

/**
 * The app's global keys: space for play/pause, `m` for mute.
 *
 * Bound to `document`, like `useEscapeKey`, because focus is rarely on the player bar when the
 * user reaches for them — and read through a ref so the listener is registered once rather than
 * re-registered on every render, while still seeing the current callbacks.
 */

export interface KeyboardShortcutsOptions {
  /** False disables everything (a dialog is open). */
  enabled: boolean
  /** Space only acts when a song is actually cued. */
  hasCurrentSong: boolean
  onTogglePlay(): void
  onToggleMute(): void
}

/** Somewhere the user is typing: every key belongs to them, none to the player. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Space already activates these. Acting on it too would fire the control AND the transport. */
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

      // A combination belongs to the OS or to the app chrome, never to the transport: ⌘M is
      // Minimize on macOS, and answering it here would silently mute — and persist that mute — as
      // the window went down. Shift is not in the list: it is how the keyboard produces `M`.
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const { enabled, hasCurrentSong, onTogglePlay, onToggleMute } = latest.current
      if (!enabled || isTyping(event.target)) return

      if (event.key === ' ') {
        if (SPACE_ACTIVATED_TAGS.has(tagOf(event.target) ?? '')) return
        // Deliberately not a cold start: space resumes what is cued, it does not choose a song.
        if (!hasCurrentSong) return
        // Otherwise the window scrolls under the song list on every press.
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
