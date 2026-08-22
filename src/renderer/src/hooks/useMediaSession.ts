import { useEffect } from 'react'

/**
 * Mirrors playback into the OS "now playing" surface — this is what makes AirPods taps work, since
 * macOS turns double/triple taps into next/previous-track commands the app never sees as taps.
 * Handlers are registered only while a song is cued, so the app claims the transport only then.
 */

export interface MediaSessionOptions {
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

  // Keyed on whether a song exists, not which: a track change must not re-register the handlers.
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
