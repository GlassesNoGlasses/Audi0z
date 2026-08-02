import { useEffect, useRef, type RefObject } from 'react'

/**
 * Drives the app's one `<audio>` element from playback state.
 *
 * The load effect is keyed on `[songId, src, playToken]` and is deliberately picky about `src`:
 * assigning it restarts the network fetch, so it is only written when the song actually changed.
 * `currentTime = 0` plus `play()` runs on EVERY play-token bump, which is what makes replaying the
 * song that is already loaded (repeat, or clicking the current row again) audible.
 */

export interface UseAudioElementOptions {
  /** The cued song's id, or null when nothing is cued. */
  songId: string | null
  /** `media://audio/<id>` for the cued song. Null exactly when `songId` is. */
  src: string | null
  /** Bumped by the engine on every (re)start of the current song. */
  playToken: number
  isPlaying: boolean
  /** 0..1, from settings. */
  volume: number
  onEnded(): void
  onError(songId: string): void
}

function start(audio: HTMLAudioElement): void {
  // The promise rejects on an interrupted play (a fast next/next/next); nothing to do about it.
  void Promise.resolve(audio.play()).catch(() => undefined)
}

export function useAudioElement({
  songId,
  src,
  playToken,
  isPlaying,
  volume,
  onEnded,
  onError
}: UseAudioElementOptions): RefObject<HTMLAudioElement> {
  const ref = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const audio = ref.current
    if (!audio || songId === null || src === null) return
    if (audio.getAttribute('src') !== src) audio.src = src
    audio.currentTime = 0
    start(audio)
  }, [songId, src, playToken])

  useEffect(() => {
    const audio = ref.current
    if (!audio) return
    if (isPlaying && songId !== null) start(audio)
    else audio.pause()
  }, [isPlaying, songId])

  useEffect(() => {
    const audio = ref.current
    if (audio) audio.volume = volume
  }, [volume])

  useEffect(() => {
    const audio = ref.current
    if (!audio) return
    const handleEnded = (): void => onEnded()
    const handleError = (): void => {
      if (songId !== null) onError(songId)
    }
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    return () => {
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
    }
  }, [songId, onEnded, onError])

  return ref
}
