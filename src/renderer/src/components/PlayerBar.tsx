import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useSmartPrev } from '../hooks/useSmartPrev'
import { useToastError } from '../hooks/useToastError'
import { formatDuration } from '../lib/format'
import { currentSong } from '../playback/selectors'
import { LIBRARY_QUEUE_ID } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'

/** Long enough to collapse a slider drag into one write, short enough to survive a quick quit. */
const VOLUME_DEBOUNCE_MS = 250

export interface PlayerBarProps {
  audioRef: RefObject<HTMLAudioElement>
  /** Brackets a drag of the seek slider in silence — see `useAudioElement`. */
  beginScrub(): void
  endScrub(): void
}

/**
 * Transport, toggles and the two sliders.
 *
 * Position is read straight off the `<audio>` element rather than from the store: it changes four
 * times a second and nothing else in the app cares about it.
 */
export function PlayerBar({ audioRef, beginScrub, endScrub }: PlayerBarProps): ReactElement {
  const { songs, playback, settings } = useAppState()
  const dispatch = useAppDispatch()
  const prev = useSmartPrev(audioRef)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const current = currentSong(songs, playback)
  const canPlay = playback.currentId !== null || playback.order.length > 0

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const sync = (): void => {
      setPosition(audio.currentTime)
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    }
    const events = ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied'] as const
    for (const event of events) audio.addEventListener(event, sync)
    return () => {
      for (const event of events) audio.removeEventListener(event, sync)
    }
  }, [audioRef])

  // A new song (or a restart) rewinds the display before the element has reported anything.
  useEffect(() => {
    setPosition(0)
  }, [playback.currentId, playback.playToken])

  useEffect(() => {
    return () => {
      if (volumeTimer.current !== null) clearTimeout(volumeTimer.current)
    }
  }, [])

  const fail = useToastError()

  /**
   * Shuffle and repeat are dual-writes: the engine gets them now, and whichever store owns the
   * current queue gets them too, so they survive a restart.
   */
  function persistToggle(patch: { shuffle: boolean } | { repeat: boolean }): void {
    const { queueId } = playback
    if (queueId === null) return
    if (queueId === LIBRARY_QUEUE_ID) {
      void window.api.settings
        .set(
          'shuffle' in patch ? { libraryShuffle: patch.shuffle } : { libraryRepeat: patch.repeat }
        )
        .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
        .catch(fail)
      return
    }
    void window.api.playlists
      .setPlaybackOptions(queueId, patch)
      .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
      .catch(fail)
  }

  function setShuffle(value: boolean): void {
    dispatch({ type: 'transport/setShuffle', value })
    persistToggle({ shuffle: value })
  }

  function setRepeat(value: boolean): void {
    dispatch({ type: 'transport/setRepeat', value })
    persistToggle({ repeat: value })
  }

  function changeVolume(value: number): void {
    dispatch({ type: 'settings/updated', settings: { ...settings, volume: value } })
    if (volumeTimer.current !== null) clearTimeout(volumeTimer.current)
    volumeTimer.current = setTimeout(() => {
      void window.api.settings
        .set({ volume: value })
        .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
        .catch(fail)
    }, VOLUME_DEBOUNCE_MS)
  }

  function seek(value: number): void {
    const audio = audioRef.current
    if (audio) audio.currentTime = value
    setPosition(value)
  }

  return (
    <footer className="player-bar">
      <div className="player-transport">
        <button
          type="button"
          aria-label="Previous"
          disabled={playback.currentId === null}
          onClick={prev}
        >
          ⏮
        </button>
        <button
          type="button"
          className="player-play"
          // `transport/togglePlay` covers both cases: it starts the queue when nothing is cued yet,
          // which `transport/play` would not (it would leave `isPlaying` on with no current song).
          aria-label={playback.isPlaying && playback.currentId !== null ? 'Pause' : 'Play'}
          disabled={!canPlay}
          onClick={() => dispatch({ type: 'transport/togglePlay' })}
        >
          {playback.isPlaying && playback.currentId !== null ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          aria-label="Next"
          disabled={playback.order.length === 0}
          onClick={() => dispatch({ type: 'transport/next' })}
        >
          ⏭
        </button>
      </div>

      <div className="player-main">
        <div className="player-title">{current ? current.title : 'Nothing playing'}</div>
        <div className="player-seek">
          <span className="player-time">{formatDuration(position, '0:00')}</span>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={duration}
            step={0.1}
            value={Math.min(position, duration)}
            disabled={current === null || duration === 0}
            // The seek itself stays on `change` — the element has to move with the thumb — while
            // the pointer brackets it in silence, so a drag does not garble every value it crosses.
            onChange={(event) => seek(Number(event.target.value))}
            onPointerDown={beginScrub}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            // Insurance: a release that never retargets the input fires neither of the two above,
            // and the scrub silence would outlive the drag — element paused, store still playing.
            onLostPointerCapture={endScrub}
          />
          <span className="player-time">{formatDuration(duration, '0:00')}</span>
        </div>
      </div>

      <div className="player-toggles">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={playback.shuffle}
          onClick={() => setShuffle(!playback.shuffle)}
        >
          ⇆
        </button>
        <button
          type="button"
          aria-label="Repeat"
          aria-pressed={playback.repeat}
          onClick={() => setRepeat(!playback.repeat)}
        >
          ᦠ
        </button>
        <input
          type="range"
          className="player-volume"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.01}
          value={settings.volume}
          onChange={(event) => changeVolume(Number(event.target.value))}
        />
      </div>
    </footer>
  )
}
