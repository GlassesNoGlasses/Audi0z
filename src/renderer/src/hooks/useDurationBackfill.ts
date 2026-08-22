import { useEffect, useRef, type Dispatch } from 'react'
import type { SongDto } from '../../../shared/types'
import type { AppAction } from '../state/appReducer'

/** Probes share the main process's four-thread `media://` pool with the playing song. */
const MAX_CONCURRENT = 2

/** How many measured songs ride in one library write. */
const FLUSH_SIZE = 8

/**
 * Fills in missing playing times by decoding headers in the renderer, persisted in batches.
 *
 * Silent by design: a file that will not answer is asked once and never retried this session.
 * `idle` (nothing playing) gates new reads — the playing song has first claim on the media pool.
 */
export function useDurationBackfill(
  songs: SongDto[],
  dispatch: Dispatch<AppAction>,
  idle: boolean
): void {
  /** Ids already taken a run at, so a growing library never re-measures. */
  const attempted = useRef<Set<string>>(new Set())
  /** Songs enqueued and not yet picked up by a reader. */
  const waiting = useRef<SongDto[]>([])
  /** Measurements taken and not yet written. */
  const pending = useRef<Array<{ id: string; durationSec: number }>>([])
  const readers = useRef(0)
  const mounted = useRef(true)
  /** The readers below outlive the render that spawned them, so they read `idle` from here. */
  const idleRef = useRef(idle)
  /** One per read in flight: an unmount must not leave media elements loading behind it. */
  const aborts = useRef<Set<() => void>>(new Set())

  useEffect(() => {
    // Safe to read here: these containers are created once and only ever mutated.
    const seen = attempted.current
    const queued = waiting.current
    const batched = pending.current
    const running = aborts.current

    mounted.current = true
    return () => {
      mounted.current = false
      // Un-mark unwritten measurements: the next mount re-probes them.
      for (const entry of batched) seen.delete(entry.id)
      batched.length = 0
      // React's dev double-mount runs this between two mounts, so anything un-run must be un-marked
      // or it is skipped for the whole life of the second mount.
      for (const song of queued) seen.delete(song.id)
      queued.length = 0
      for (const abort of [...running]) abort()
      running.clear()
    }
  }, [])

  // Declared first so an `idle` change lands here before the effect that spawns readers runs.
  useEffect(() => {
    idleRef.current = idle
  }, [idle])

  useEffect(() => {
    for (const song of songs) {
      if (!song.exists || song.durationSec !== undefined) continue
      if (attempted.current.has(song.id)) continue
      // Marked on the way IN: readers outlive this effect, so a queued song must not re-queue.
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
          // Lets go of the file rather than leaving an abandoned probe holding it open.
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

    /** One write for what has been measured; `splice` lets two readers flush without overlap. */
    async function flush(): Promise<void> {
      const batch = pending.current.splice(0, pending.current.length)
      if (batch.length === 0) return
      try {
        const updated = await window.api.library.updateDurations(batch)
        if (mounted.current && updated.length > 0) {
          dispatch({ type: 'library/songsUpdated', songs: updated })
        }
      } catch {
        // Silent by design: a toast per batch would bury the failures the user asked for.
      }
    }

    async function drain(): Promise<void> {
      // Re-read each turn: playback starting stops the next read, never the one in flight.
      while (mounted.current && idleRef.current) {
        const song = waiting.current.shift()
        if (song === undefined) return
        const seconds = await read(song)
        if (seconds === null) continue
        const durationSec = Math.round(seconds)
        // The library refuses 0 — and the whole batch with it — so sub-second files are left out.
        if (durationSec <= 0) continue
        pending.current.push({ id: song.id, durationSec })
        if (pending.current.length >= FLUSH_SIZE) await flush()
      }
    }

    while (mounted.current && readers.current < MAX_CONCURRENT && waiting.current.length > 0) {
      readers.current += 1
      void drain().finally(() => {
        readers.current -= 1
        // Last reader out writes the tail batch.
        if (readers.current === 0) void flush()
      })
    }
    // `idle` is in the deps so going quiet re-runs this and spawns readers over the queue.
  }, [songs, dispatch, idle])
}
