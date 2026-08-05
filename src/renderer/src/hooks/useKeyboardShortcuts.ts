import { useEffect, useRef } from 'react'

/**
 * The app's global keys: space for play/pause, `m` for mute, ←/→ to skip.
 *
 * Bound to `document`, like `useEscapeKey`, because focus is rarely on the player bar when the
 * user reaches for them — and read through a ref so the listener is registered once rather than
 * re-registered on every render, while still seeing the current callbacks.
 */

/** How far one arrow press moves the song, in seconds. */
const SEEK_STEP_SEC = 10

export interface KeyboardShortcutsOptions {
  /** False disables everything (a dialog is open). */
  enabled: boolean
  /** Space and the arrows only act when a song is actually cued. */
  hasCurrentSong: boolean
  onTogglePlay(): void
  onToggleMute(): void
  onSeekBy(delta: number): void
}

/** Somewhere the user is typing: every key belongs to them, none to the player. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Space already activates these. Acting on it too would fire the control AND the transport — so
 * they keep the key, unless they sit inside something carrying `data-space-transport`, the opt-in
 * a control uses to say its own activation is the wrong answer to a space press.
 */
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

      const { enabled, hasCurrentSong, onTogglePlay, onToggleMute, onSeekBy } = latest.current
      if (!enabled || isTyping(event.target)) return

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // The row menu's own arrow navigation runs first (React handlers beat this document
        // listener) and marks the event; a menu must never scrub the song behind it.
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
        // Song rows opt back in via `data-space-transport`: space on a focused row belongs to the
        // transport, not to replaying the row (Enter still activates it). The preventDefault below
        // is load-bearing twice over — it stops the page scroll AND cancels the button's native
        // keyup click, which is what used to restart the song.
        const optedIn = target?.closest('[data-space-transport]') != null
        if (!optedIn && SPACE_ACTIVATED_TAGS.has(tagOf(event.target) ?? '')) return
        // Deliberately not a cold start: space resumes what is cued, it does not choose a song.
        // An opted-in control lands here un-prevented, so its own activation still gets the press.
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
