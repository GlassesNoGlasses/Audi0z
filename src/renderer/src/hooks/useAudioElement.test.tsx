import { fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playSpy, stubDuration, stubMediaElement } from '../testing/harness'
import {
  useAudioElement,
  type AudioController,
  type UseAudioElementOptions
} from './useAudioElement'

/** R11: replaying the loaded song resets `currentTime` and calls `play()` without setting `src`. */

stubMediaElement()

afterEach(() => {
  vi.useRealTimers()
})

/** How long the hook stays quiet after the last keyboard seek, in ms. */
const RESUME_AFTER = 300

/** The controller from the newest render. Its methods only read refs, so any instance would do. */
let controller: AudioController

function Harness(props: UseAudioElementOptions): ReactElement {
  controller = useAudioElement(props)
  return <audio ref={controller.ref} data-testid="audio" />
}

const base: UseAudioElementOptions = {
  songId: 'a',
  src: 'media://audio/a',
  playToken: 1,
  isPlaying: true,
  volume: 1,
  onEnded: () => undefined,
  onError: () => undefined
}

interface Rendered extends Omit<AudioController, 'ref'> {
  audio: HTMLAudioElement
  update: (next: Partial<UseAudioElementOptions>) => void
}

function renderHook(props: Partial<UseAudioElementOptions> = {}): Rendered {
  const initial = { ...base, ...props }
  const { getByTestId, rerender } = render(<Harness {...initial} />)
  let current = initial
  return {
    audio: getByTestId('audio') as HTMLAudioElement,
    update: (next) => {
      current = { ...current, ...next }
      rerender(<Harness {...current} />)
    },
    seekBy: (delta) => controller.seekBy(delta),
    beginScrub: () => controller.beginScrub(),
    endScrub: () => controller.endScrub()
  }
}

describe('useAudioElement', () => {
  it('loads the cued song and starts it', () => {
    const { audio } = renderHook()
    expect(audio.getAttribute('src')).toBe('media://audio/a')
    expect(playSpy()).toHaveBeenCalled()
  })

  it('restarts the same song on a play-token bump without reloading its src (R11)', () => {
    const { audio, update } = renderHook()
    audio.currentTime = 12
    const playsBefore = playSpy().mock.calls.length

    // Any write to `src` — even the same value — refetches the file and is recorded here.
    const observer = new MutationObserver(() => undefined)
    observer.observe(audio, { attributes: true, attributeFilter: ['src'] })

    update({ playToken: 2 })

    expect(audio.currentTime).toBe(0)
    expect(playSpy().mock.calls.length).toBe(playsBefore + 1)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it('swaps the src when a different song is cued', () => {
    const { audio, update } = renderHook()
    update({ songId: 'b', src: 'media://audio/b', playToken: 2 })
    expect(audio.getAttribute('src')).toBe('media://audio/b')
  })

  it('pauses when playback stops, and does not touch currentTime', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const { audio, update } = renderHook()
    audio.currentTime = 9

    update({ isPlaying: false })

    expect(pause).toHaveBeenCalled()
    expect(audio.currentTime).toBe(9)
  })

  it('applies the volume from settings', () => {
    const { audio, update } = renderHook({ volume: 0.4 })
    expect(audio.volume).toBe(0.4)
    update({ volume: 0.9 })
    expect(audio.volume).toBe(0.9)
  })

  it('reports the end of a song', () => {
    const onEnded = vi.fn()
    const { audio } = renderHook({ onEnded })
    fireEvent.ended(audio)
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('reports a playback error against the song that failed', () => {
    const onError = vi.fn()
    const { audio } = renderHook({ onError })
    fireEvent.error(audio)
    expect(onError).toHaveBeenCalledWith('a')
  })

  it('does nothing at all while no song is cued', () => {
    const { audio } = renderHook({ songId: null, src: null, isPlaying: false })
    expect(audio.getAttribute('src')).toBeNull()
    expect(playSpy()).not.toHaveBeenCalled()
  })
})

/** Seeking is element-local: nothing here touches the store, so the ⏸ glyph never flickers. */
describe('useAudioElement — seeking', () => {
  it('seeks forward ten seconds, silent, then resumes on its own', () => {
    vi.useFakeTimers()
    const { audio, seekBy } = renderHook()
    audio.currentTime = 30
    const plays = playSpy().mock.calls.length

    seekBy(10)

    expect(audio.currentTime).toBe(40)
    expect(audio.paused).toBe(true)
    expect(playSpy().mock.calls.length).toBe(plays)

    vi.advanceTimersByTime(RESUME_AFTER)

    expect(audio.paused).toBe(false)
    expect(playSpy().mock.calls.length).toBe(plays + 1)
  })

  it('waits out the whole run of presses before resuming', () => {
    vi.useFakeTimers()
    const { audio, seekBy } = renderHook()
    audio.currentTime = 0

    seekBy(10)
    vi.advanceTimersByTime(RESUME_AFTER - 100)
    seekBy(10)
    vi.advanceTimersByTime(RESUME_AFTER - 100)

    expect(audio.currentTime).toBe(20)
    expect(audio.paused).toBe(true)

    vi.advanceTimersByTime(100)

    expect(audio.paused).toBe(false)
  })

  it('never seeks past the start', () => {
    const { audio, seekBy } = renderHook()
    audio.currentTime = 4

    seekBy(-10)

    expect(audio.currentTime).toBe(0)
  })

  it('stops just short of the end so a skip never ends the song itself', () => {
    const { audio, seekBy } = renderHook()
    stubDuration(audio, 60)
    audio.currentTime = 55

    seekBy(10)

    // Landing exactly on the duration fires `ended`, which would hand the queue the next song.
    expect(audio.currentTime).toBe(59.75)
  })

  it('stays paused after a seek when it was already paused', () => {
    vi.useFakeTimers()
    const { audio, seekBy, update } = renderHook()
    update({ isPlaying: false })
    audio.currentTime = 10
    const plays = playSpy().mock.calls.length

    seekBy(10)
    vi.advanceTimersByTime(RESUME_AFTER)

    expect(audio.currentTime).toBe(20)
    expect(audio.paused).toBe(true)
    expect(playSpy().mock.calls.length).toBe(plays)
  })

  it('does nothing with no song cued', () => {
    const { audio, seekBy } = renderHook({ songId: null, src: null, isPlaying: false })
    audio.currentTime = 5

    seekBy(10)

    expect(audio.currentTime).toBe(5)
  })
})

describe('useAudioElement — scrubbing', () => {
  it('a pointer scrub is silent from press to release', () => {
    const { audio, beginScrub, endScrub } = renderHook()

    beginScrub()
    expect(audio.paused).toBe(true)

    // What the slider's own onChange does while the pointer is down.
    audio.currentTime = 18
    endScrub()

    expect(audio.paused).toBe(false)
    expect(audio.currentTime).toBe(18)
  })

  it('releasing a scrub on a paused song leaves it paused', () => {
    const { audio, beginScrub, endScrub, update } = renderHook()
    update({ isPlaying: false })

    beginScrub()
    endScrub()

    expect(audio.paused).toBe(true)
  })

  it('lets the store pause a song out from under a held scrub', () => {
    const { audio, beginScrub, endScrub, update } = renderHook()

    beginScrub()
    update({ isPlaying: false })
    endScrub()

    expect(audio.paused).toBe(true)
  })

  it('drops a pending resume when the song changes', () => {
    vi.useFakeTimers()
    const { seekBy, update } = renderHook()

    seekBy(10)
    update({ songId: 'b', src: 'media://audio/b', playToken: 2 })
    const plays = playSpy().mock.calls.length

    vi.advanceTimersByTime(RESUME_AFTER)

    expect(playSpy().mock.calls.length).toBe(plays)
  })

  it('a release takes over the resume a keyboard seek had pending', () => {
    vi.useFakeTimers()
    const { audio, seekBy, endScrub } = renderHook()

    seekBy(10)
    endScrub()
    expect(audio.paused).toBe(false)
    const plays = playSpy().mock.calls.length

    vi.advanceTimersByTime(RESUME_AFTER)

    expect(playSpy().mock.calls.length).toBe(plays)
  })

  it('a press takes over the resume a keyboard seek had pending', () => {
    vi.useFakeTimers()
    const { audio, seekBy, beginScrub, endScrub } = renderHook()

    seekBy(10)
    beginScrub()
    vi.advanceTimersByTime(RESUME_AFTER)

    expect(audio.paused).toBe(true)

    endScrub()

    expect(audio.paused).toBe(false)
  })
})
