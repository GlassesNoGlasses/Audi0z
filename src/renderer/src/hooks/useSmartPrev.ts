import { useCallback, type RefObject } from 'react'
import { useAppDispatch } from '../state/AppContext'

/** Played longer than this and Previous means "start this song over", not "go back one". */
export const PREV_RESTART_SEC = 5

/**
 * The Previous intent, gated the way every player since the iPod gates it: deep enough into the
 * song, the button rewinds it instead of leaving it. The rewind is element-only — exactly like a
 * seek, the store never hears about it — so play/pause state, the queue, and the history stack
 * are all untouched. At or under the threshold the engine's `transport/prev` does what it always
 * did (walk the history stack, or restart when there is nowhere left to walk).
 */
export function useSmartPrev(audioRef: RefObject<HTMLAudioElement>): () => void {
  const dispatch = useAppDispatch()
  return useCallback(() => {
    const audio = audioRef.current
    if (audio && audio.currentTime > PREV_RESTART_SEC) {
      audio.currentTime = 0
      return
    }
    dispatch({ type: 'transport/prev' })
  }, [audioRef, dispatch])
}
