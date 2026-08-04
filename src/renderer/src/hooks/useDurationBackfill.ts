import { useEffect, useRef, type Dispatch } from 'react'
import type { SongDto } from '../../../shared/types'
import type { AppAction } from '../state/appReducer'

/**
 * How many files are read at once. Reading metadata is cheap but it is still disk, and the song
 * playing has first claim on it — two keeps the backfill moving without ever being felt.
 */
const MAX_CONCURRENT = 2

/**
 * Fills in the playing time of songs that have none.
 *
 * A song's duration is not known until something has decoded its header, and doing that in the
 * main process would mean an ffprobe run per song before the window could even be drawn. So the
 * renderer measures instead: the list paints immediately with `–:––` where a time is missing, and
 * these probes fill them in behind it and persist what they find, once, for good.
 *
 * It is deliberately silent. Nobody asked for this work, so a file that will not answer is asked
 * once and then left alone — no toast, no retry, no second look this session.
 */
export function useDurationBackfill(songs: SongDto[], dispatch: Dispatch<AppAction>): void {
  /** Ids already taken a run at, so a growing library never re-measures what it has measured. */
  const attempted = useRef<Set<string>>(new Set())
  /** Songs enqueued and not yet picked up by a reader. */
  const waiting = useRef<SongDto[]>([])
  const readers = useRef(0)
  const mounted = useRef(true)
  /** One per read in flight: an unmount must not leave media elements loading behind it. */
  const aborts = useRef<Set<() => void>>(new Set())

  useEffect(() => {
    // Read here rather than in the cleanup: these three containers are created once and only ever
    // mutated, so holding them is holding the same collections the cleanup would have looked up.
    const seen = attempted.current
    const queued = waiting.current
    const running = aborts.current

    mounted.current = true
    return () => {
      mounted.current = false
      // Nothing queued or in flight got its chance, so forget it was ever asked for. React's
      // development double-mount runs this between two mounts, and a song marked attempted on the
      // first would otherwise be skipped for the whole life of the second.
      for (const song of queued) seen.delete(song.id)
      queued.length = 0
      for (const abort of [...running]) abort()
      running.clear()
    }
  }, [])

  useEffect(() => {
    for (const song of songs) {
      if (!song.exists || song.durationSec !== undefined) continue
      if (attempted.current.has(song.id)) continue
      // Marked on the way IN, not on the way out: the readers below outlive this effect (every
      // measurement dispatches, which re-runs it), and a song already waiting its turn must not be
      // queued a second time by the render that follows.
      attempted.current.add(song.id)
      waiting.current.push(song)
    }

    /** One song's playing time, or null when the file will not give one up. */
    function read(song: SongDto): Promise<number | null> {
      return new Promise((resolve) => {
        const audio = new Audio()

        const settle = (seconds: number | null): void => {
          audio.removeEventListener('loadedmetadata', onLoaded)
          audio.removeEventListener('error', onFailed)
          // Lets go of the file rather than leaving a probe nobody is waiting for holding it open.
          audio.removeAttribute('src')
          aborts.current.delete(abort)
          resolve(seconds)
        }
        const onLoaded = (): void => {
          // A live stream reports Infinity and an empty file reports 0: neither is a playing time.
          const seconds = audio.duration
          settle(Number.isFinite(seconds) && seconds > 0 ? seconds : null)
        }
        const onFailed = (): void => settle(null)
        const abort = (): void => {
          // Cut short rather than answered: this song is owed another look on the next mount.
          attempted.current.delete(song.id)
          settle(null)
        }

        aborts.current.add(abort)
        audio.addEventListener('loadedmetadata', onLoaded)
        audio.addEventListener('error', onFailed)
        audio.preload = 'metadata'
        audio.src = song.url
      })
    }

    async function drain(): Promise<void> {
      while (mounted.current) {
        const song = waiting.current.shift()
        if (song === undefined) return
        const seconds = await read(song)
        if (seconds === null) continue
        try {
          const updated = await window.api.library.update(song.id, {
            durationSec: Math.round(seconds)
          })
          if (mounted.current) dispatch({ type: 'library/songUpdated', song: updated })
        } catch {
          // Silent by design: a library that will not take a write says so loudly on every path
          // the user actually asked for, and a toast per song would bury those.
        }
      }
    }

    while (mounted.current && readers.current < MAX_CONCURRENT && waiting.current.length > 0) {
      readers.current += 1
      void drain().finally(() => {
        readers.current -= 1
      })
    }
  }, [songs, dispatch])
}
