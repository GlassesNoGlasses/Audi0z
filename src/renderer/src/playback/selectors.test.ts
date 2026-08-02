import { describe, expect, it } from 'vitest'
import { currentIndex, isPlayed, playedCount } from './selectors'
import { LIBRARY_QUEUE_ID } from './types'
import type { PlaybackState } from './types'

const PLAYLIST_QUEUE_ID = 'playlist-1'

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    queueId: LIBRARY_QUEUE_ID,
    order: ['a', 'b', 'c'],
    currentId: null,
    playedByQueue: {},
    history: [],
    shuffle: false,
    repeat: false,
    isPlaying: false,
    playToken: 0,
    ...overrides
  }
}

describe('isPlayed', () => {
  it('reports flags of the current queue only', () => {
    const state = makeState({
      playedByQueue: { [LIBRARY_QUEUE_ID]: { a: true }, [PLAYLIST_QUEUE_ID]: { b: true } }
    })
    expect(isPlayed(state, 'a')).toBe(true)
    expect(isPlayed(state, 'b')).toBe(false)
  })

  it('is false when the queue has no flags yet, and when no queue is selected', () => {
    expect(isPlayed(makeState(), 'a')).toBe(false)
    expect(isPlayed(makeState({ queueId: null }), 'a')).toBe(false)
  })
})

describe('currentIndex', () => {
  it('is the position of the current song in the queue order', () => {
    expect(currentIndex(makeState({ currentId: 'b' }))).toBe(1)
  })

  it('is -1 when nothing is current or the current song left the queue', () => {
    expect(currentIndex(makeState())).toBe(-1)
    expect(currentIndex(makeState({ currentId: 'gone' }))).toBe(-1)
  })
})

describe('playedCount', () => {
  it("counts the current queue's flags only", () => {
    const state = makeState({
      playedByQueue: {
        [LIBRARY_QUEUE_ID]: { a: true, b: true },
        [PLAYLIST_QUEUE_ID]: { a: true, b: true, c: true }
      }
    })
    expect(playedCount(state)).toBe(2)
  })

  it('is 0 for an untouched queue and when no queue is selected', () => {
    expect(playedCount(makeState())).toBe(0)
    expect(playedCount(makeState({ queueId: null }))).toBe(0)
  })
})
