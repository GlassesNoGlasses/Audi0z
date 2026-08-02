import { fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { playSpy, stubMediaElement } from '../testing/harness'
import { useAudioElement, type UseAudioElementOptions } from './useAudioElement'

/**
 * The hook owns the single `<audio>` element. The regression it exists to prevent (R11): replaying
 * the song that is already loaded must restart it audibly, which means resetting `currentTime` and
 * calling `play()` again WITHOUT reassigning `src` (a reassignment refetches the whole file).
 */

stubMediaElement()

function Harness(props: UseAudioElementOptions): ReactElement {
  const ref = useAudioElement(props)
  return <audio ref={ref} data-testid="audio" />
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

function renderHook(props: Partial<UseAudioElementOptions> = {}): {
  audio: HTMLAudioElement
  update: (next: Partial<UseAudioElementOptions>) => void
} {
  const initial = { ...base, ...props }
  const { getByTestId, rerender } = render(<Harness {...initial} />)
  let current = initial
  return {
    audio: getByTestId('audio') as HTMLAudioElement,
    update: (next) => {
      current = { ...current, ...next }
      rerender(<Harness {...current} />)
    }
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
