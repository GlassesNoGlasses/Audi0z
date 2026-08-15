import { useEffect } from 'react'

/**
 * Mirrors playback into the OS "now playing" surface via the Media Session API.
 *
 * This is what makes AirPods taps work: macOS decodes a double tap into a next-track remote
 * command and a triple tap into previous-track (per the user's Bluetooth settings — the app never
 * sees taps), Chromium turns those commands into media-session actions, and the handlers below
 * turn the actions into transport dispatches. Handlers are only registered while a song is cued,
 * so with nothing to control the app does not claim the system transport at all.
 */

export interface MediaSessionOptions {
  /** Current song title, or null when nothing is cued. */
  title: string | null
  isPlaying: boolean
  onPlay(): void
  onPause(): void
  onNext(): void
  onPrev(): void
}

const ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack'] as const

export function useMediaSession({
  title,
  isPlaying,
  onPlay,
  onPause,
  onNext,
  onPrev
}: MediaSessionOptions): void {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (title === null) {
      session.metadata = null
      session.playbackState = 'none'
      return
    }
    session.metadata = new MediaMetadata({ title })
    session.playbackState = isPlaying ? 'playing' : 'paused'
  }, [title, isPlaying])

  // Registration cares only whether a song exists, not which one — the handlers are the same four
  // either way, so a track change must not tear them down and put them back.
  const hasSong = title !== null

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (!hasSong) {
      for (const action of ACTIONS) session.setActionHandler(action, null)
      return
    }
    session.setActionHandler('play', onPlay)
    session.setActionHandler('pause', onPause)
    session.setActionHandler('nexttrack', onNext)
    session.setActionHandler('previoustrack', onPrev)
    return () => {
      for (const action of ACTIONS) session.setActionHandler(action, null)
    }
  }, [hasSong, onPlay, onPause, onNext, onPrev])
}
