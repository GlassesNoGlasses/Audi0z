import { useEffect, useRef, type RefObject } from 'react'

/**
 * Drives the app's one `<audio>` element from playback state.
 *
 * The load effect is keyed on `[songId, src, playToken]` and is deliberately picky about `src`:
 * assigning it restarts the network fetch, so it is only written when the song actually changed.
 * `currentTime = 0` plus `play()` runs on EVERY play-token bump, which is what makes replaying the
 * song that is already loaded (repeat, or clicking the current row again) audible.
 *
 * Seeking is the other half: it moves the element and nothing else. The store never hears about it,
 * so `isPlaying` — and with it the ⏸ glyph — stays honest while the user skips around.
 */

/** How long after the last keyboard seek the audio stays silent before resuming on its own. */
const SEEK_RESUME_MS = 300
/** A forward skip stops just short of the end: reaching it would fire `ended` and change songs. */
const END_GUARD_SEC = 0.25

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

export interface AudioController {
  ref: RefObject<HTMLAudioElement>
  /**
   * Seek by `delta` seconds, clamped to [0, ~duration); the audio stays silent until the scrub
   * settles a moment after the last press.
   */
  seekBy(delta: number): void
  /** Pointer-scrub bracket: silence on press, resume (if the store says playing) on release. */
  beginScrub(): void
  endScrub(): void
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
}: UseAudioElementOptions): AudioController {
  const ref = useRef<HTMLAudioElement>(null)
  /** The scrub callbacks outlive the render that made them, so they read state from here. */
  const latest = useRef({ isPlaying, songId })
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latest.current = { isPlaying, songId }
  }, [isPlaying, songId])

  useEffect(() => {
    const audio = ref.current
    if (!audio || songId === null || src === null) return
    if (audio.getAttribute('src') !== src) audio.src = src
    audio.currentTime = 0
    start(audio)
  }, [songId, src, playToken])

  // A new song ends whatever scrub was in flight: the effect above has already decided what the
  // element is doing, and a resume owed to the song before it has no say in that.
  useEffect(() => {
    if (resumeTimer.current !== null) {
      clearTimeout(resumeTimer.current)
      resumeTimer.current = null
    }
  }, [songId])

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

  useEffect(() => {
    return () => {
      if (resumeTimer.current !== null) clearTimeout(resumeTimer.current)
    }
  }, [])

  function silence(): void {
    const audio = ref.current
    if (!audio) return
    if (!audio.paused) audio.pause()
  }

  function settle(): void {
    const audio = ref.current
    if (!audio) return
    // The store, not the element, says whether sound comes back: a scrub during pause stays paused.
    if (latest.current.isPlaying && latest.current.songId !== null) start(audio)
  }

  function beginScrub(): void {
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current)
    silence()
  }

  function endScrub(): void {
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current)
    settle()
  }

  function seekBy(delta: number): void {
    const audio = ref.current
    if (!audio || latest.current.songId === null) return
    silence()
    const duration = audio.duration
    const cap = Number.isFinite(duration) ? Math.max(0, duration - END_GUARD_SEC) : Infinity
    audio.currentTime = Math.min(Math.max(audio.currentTime + delta, 0), cap)
    // Keyboard has no release event; a short quiet window after the last press is the "let go".
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current)
    resumeTimer.current = setTimeout(settle, SEEK_RESUME_MS)
  }

  return { ref, seekBy, beginScrub, endScrub }
}
