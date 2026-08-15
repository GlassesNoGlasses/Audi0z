import { act, render } from '@testing-library/react'
import type { Dispatch, ReactElement, RefObject } from 'react'
import { describe, expect, it } from 'vitest'
import { LIBRARY_QUEUE_ID, type PlaybackState } from '../playback/types'
import { AppProvider, useAppDispatch, useAppState } from '../state/AppContext'
import type { AppAction } from '../state/appReducer'
import { useSmartPrev } from './useSmartPrev'

/**
 * Driven against the real store rather than a dispatch spy: the ≤5s path has to prove the engine
 * actually heard the intent and walked its history, and the >5s path has to prove it never did.
 *
 * The `<audio>` here is a bare jsdom element with no pipeline behind it — writing `currentTime`
 * sets the property and fires nothing, which is all this hook ever asks of it.
 */

/** The store handle and the callback under test, from the newest render. */
let dispatch: Dispatch<AppAction>
let playback: PlaybackState
let prev: () => void

function Probe({ audioRef }: { audioRef: RefObject<HTMLAudioElement> }): ReactElement {
  dispatch = useAppDispatch()
  playback = useAppState().playback
  prev = useSmartPrev(audioRef)
  return <div />
}

interface Harness {
  /** Presses Previous. */
  press(): void
  currentId(): string | null
  playToken(): number
}

/** Plays Alpha and then Bravo, so the history stack has somewhere to walk back to. */
function setup(audioRef: RefObject<HTMLAudioElement>): Harness {
  render(
    <AppProvider>
      <Probe audioRef={audioRef} />
    </AppProvider>
  )
  act(() => {
    dispatch({
      type: 'queue/selected',
      queueId: LIBRARY_QUEUE_ID,
      order: ['a', 'b'],
      shuffle: false,
      repeat: false,
      startSongId: 'a'
    })
  })
  act(() => {
    dispatch({ type: 'song/selected', songId: 'b' })
  })

  return {
    press: () => act(() => prev()),
    currentId: () => playback.currentId,
    playToken: () => playback.playToken
  }
}

describe('useSmartPrev', () => {
  it('rewinds the element and says nothing to the engine past the threshold', () => {
    const audio = document.createElement('audio')
    const { press, currentId, playToken } = setup({ current: audio })
    audio.currentTime = 6
    const token = playToken()

    press()

    expect(audio.currentTime).toBe(0)
    // Both halves of "the engine never heard it": no step back, and no restart either.
    expect(currentId()).toBe('b')
    expect(playToken()).toBe(token)
  })

  it('steps back through the history at the threshold, leaving the element alone', () => {
    // Exactly 5s is still a step back: the rewind starts *past* the threshold, not at it.
    const audio = document.createElement('audio')
    const { press, currentId } = setup({ current: audio })
    audio.currentTime = 5

    press()

    expect(currentId()).toBe('a')
    expect(audio.currentTime).toBe(5)
  })

  it('steps back with no element to read a position off', () => {
    const { press, currentId } = setup({ current: null })

    press()

    expect(currentId()).toBe('a')
  })
})
