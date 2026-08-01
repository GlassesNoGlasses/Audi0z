import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseNext, defaultRng, initialPlaybackState } from './engine'
import { LIBRARY_QUEUE_ID } from './types'
import type { PlaybackState, Rng } from './types'

/** An rng that fails the test if the engine consults it. */
const forbiddenRng: Rng = () => {
  throw new Error('rng must not be consulted')
}

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return { ...initialPlaybackState(), queueId: LIBRARY_QUEUE_ID, ...overrides }
}

/** Played-flag map for the library queue. */
function played(...songIds: string[]): PlaybackState['playedByQueue'] {
  return { [LIBRARY_QUEUE_ID]: Object.fromEntries(songIds.map((id) => [id, true])) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initialPlaybackState', () => {
  it('starts with no queue, nothing played and nothing playing', () => {
    expect(initialPlaybackState()).toEqual({
      queueId: null,
      order: [],
      currentId: null,
      playedByQueue: {},
      history: [],
      shuffle: false,
      repeat: false,
      isPlaying: false,
      playToken: 0
    })
  })
})

describe('defaultRng', () => {
  it('returns an integer inside [0, upperExclusive)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(defaultRng(4)).toBe(3)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(defaultRng(4)).toBe(0)
  })
})

describe('chooseNext — sequential', () => {
  it('returns nothing for an empty queue', () => {
    expect(chooseNext(makeState({ order: [] }), forbiddenRng)).toEqual({
      songId: null,
      resetPlayed: false
    })
  })

  it('starts at the first song when nothing is current', () => {
    expect(chooseNext(makeState({ order: ['a', 'b', 'c'] }), forbiddenRng)).toEqual({
      songId: 'a',
      resetPlayed: false
    })
  })

  it('advances to the next index mid-list', () => {
    const state = makeState({ order: ['a', 'b', 'c'], currentId: 'b' })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'c', resetPlayed: false })
  })

  it('wraps to the first song and resets played flags after the last one', () => {
    const state = makeState({ order: ['a', 'b', 'c'], currentId: 'c' })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'a', resetPlayed: true })
  })

  it('repeats the only song of a single-song queue, with a reset', () => {
    const state = makeState({ order: ['a'], currentId: 'a' })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'a', resetPlayed: true })
  })

  it('falls back to the first song when the current id is no longer in the queue', () => {
    const state = makeState({ order: ['a', 'b', 'c'], currentId: 'gone' })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'a', resetPlayed: false })
  })
})

describe('chooseNext — shuffle', () => {
  const shuffled = (overrides: Partial<PlaybackState>): PlaybackState =>
    makeState({ shuffle: true, order: ['a', 'b', 'c', 'd'], ...overrides })

  it('returns the only unplayed song without consulting the rng', () => {
    const rng = vi.fn<Rng>(() => 0)
    const state = shuffled({ currentId: 'a', playedByQueue: played('a', 'b', 'd') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'c', resetPlayed: false })
    expect(rng).not.toHaveBeenCalled()
  })

  it('picks the first unplayed song in queue order when the rng returns 0', () => {
    const rng = vi.fn<Rng>(() => 0)
    const state = shuffled({ currentId: 'a', playedByQueue: played('a') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'b', resetPlayed: false })
    expect(rng).toHaveBeenCalledWith(3)
  })

  it('picks the last unplayed song when the rng returns the top of the range', () => {
    const rng: Rng = (upperExclusive) => upperExclusive - 1
    const state = shuffled({ currentId: 'a', playedByQueue: played('a') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'd', resetPlayed: false })
  })

  it('resets when everything is played, and never picks the current song again', () => {
    const state = shuffled({ currentId: 'd', playedByQueue: played('a', 'b', 'c', 'd') })
    for (let value = 0; value <= state.order.length - 2; value++) {
      const selection = chooseNext(state, () => value)
      expect(selection.resetPlayed).toBe(true)
      expect(selection.songId).not.toBe('d')
      expect(state.order).toContain(selection.songId)
    }
  })

  it('returns the same song when a single-song queue is exhausted', () => {
    const state = shuffled({ order: ['a'], currentId: 'a', playedByQueue: played('a') })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'a', resetPlayed: true })
  })

  it('never returns the current song while unplayed candidates remain', () => {
    const state = shuffled({ currentId: 'a', playedByQueue: played('a') })
    for (let seed = 0; seed < 100; seed++) {
      const rng: Rng = (upperExclusive) => (seed * 7 + 3) % upperExclusive
      const { songId, resetPlayed } = chooseNext(state, rng)
      expect(songId).not.toBe('a')
      expect(songId).not.toBeNull()
      expect(resetPlayed).toBe(false)
    }
  })
})
