import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseNext,
  createPlaybackReducer,
  defaultRng,
  initialPlaybackState,
  playbackReducer
} from './engine'
import { isPlayed, playedCount } from './selectors'
import { LIBRARY_QUEUE_ID } from './types'
import type { PlaybackAction, PlaybackState, Rng } from './types'

const PLAYLIST_QUEUE_ID = 'playlist-1'

/** An rng that fails the test if the engine consults it. */
const forbiddenRng: Rng = () => {
  throw new Error('rng must not be consulted')
}

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return { ...initialPlaybackState(), queueId: LIBRARY_QUEUE_ID, ...overrides }
}

/** Played-flag set for the current queue. */
function played(...songIds: string[]): PlaybackState['played'] {
  return Object.fromEntries(songIds.map((id) => [id, true]))
}

/** Reduces with an rng that must not be consulted — the sequential paths never need one. */
function reduce(state: PlaybackState, action: PlaybackAction): PlaybackState {
  return playbackReducer(state, action, forbiddenRng)
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
      played: {},
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
    const state = shuffled({ currentId: 'a', played: played('a', 'b', 'd') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'c', resetPlayed: false })
    expect(rng).not.toHaveBeenCalled()
  })

  it('picks the first unplayed song in queue order when the rng returns 0', () => {
    const rng = vi.fn<Rng>(() => 0)
    const state = shuffled({ currentId: 'a', played: played('a') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'b', resetPlayed: false })
    expect(rng).toHaveBeenCalledWith(3)
  })

  it('picks the last unplayed song when the rng returns the top of the range', () => {
    const rng: Rng = (upperExclusive) => upperExclusive - 1
    const state = shuffled({ currentId: 'a', played: played('a') })
    expect(chooseNext(state, rng)).toEqual({ songId: 'd', resetPlayed: false })
  })

  it('resets when everything is played, and never picks the current song again', () => {
    const state = shuffled({ currentId: 'd', played: played('a', 'b', 'c', 'd') })
    for (let value = 0; value <= state.order.length - 2; value++) {
      const selection = chooseNext(state, () => value)
      expect(selection.resetPlayed).toBe(true)
      expect(selection.songId).not.toBe('d')
      expect(state.order).toContain(selection.songId)
    }
  })

  it('returns the same song when a single-song queue is exhausted', () => {
    const state = shuffled({ order: ['a'], currentId: 'a', played: played('a') })
    expect(chooseNext(state, forbiddenRng)).toEqual({ songId: 'a', resetPlayed: true })
  })

  it('never returns the current song while unplayed candidates remain', () => {
    const state = shuffled({ currentId: 'a', played: played('a') })
    for (let seed = 0; seed < 100; seed++) {
      const rng: Rng = (upperExclusive) => (seed * 7 + 3) % upperExclusive
      const { songId, resetPlayed } = chooseNext(state, rng)
      expect(songId).not.toBe('a')
      expect(songId).not.toBeNull()
      expect(resetPlayed).toBe(false)
    }
  })
})

describe('playbackReducer — song/selected', () => {
  it('resets the queue to exactly the clicked song and starts it', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'a',
      isPlaying: false,
      playToken: 3,
      played: played('a', 'b'),
      history: ['a']
    })

    const next = reduce(state, { type: 'song/selected', songId: 'c' })

    expect(next.currentId).toBe('c')
    expect(next.isPlaying).toBe(true)
    expect(next.playToken).toBe(4)
    expect(next.played).toEqual({ c: true })
    expect(next.history).toEqual(['a', 'c'])
  })

  it('is ignored when no queue is selected, since nothing could be marked played', () => {
    const state = initialPlaybackState()
    expect(reduce(state, { type: 'song/selected', songId: 'a' })).toBe(state)
  })
})

describe('playbackReducer — song/ended', () => {
  it('restarts the same song and touches no played flags when repeat is on', () => {
    const state = makeState({
      order: ['a', 'b'],
      currentId: 'a',
      repeat: true,
      isPlaying: true,
      playToken: 2,
      played: { a: true },
      history: ['a']
    })

    const next = reduce(state, { type: 'song/ended' })

    expect(next.currentId).toBe('a')
    expect(next.playToken).toBe(3)
    expect(next.isPlaying).toBe(true)
    expect(next.played).toEqual(state.played)
    expect(next.history).toEqual(['a'])
  })

  it('marks the finished song played and advances to the next one', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'a',
      isPlaying: true,
      playToken: 1,
      history: ['a']
    })

    const next = reduce(state, { type: 'song/ended' })

    expect(next.currentId).toBe('b')
    expect(isPlayed(next, 'a')).toBe(true)
    expect(isPlayed(next, 'b')).toBe(true)
    expect(next.playToken).toBe(2)
    expect(next.isPlaying).toBe(true)
    expect(next.history).toEqual(['a', 'b'])
  })

  it('wraps past the last song, leaving exactly the first one played', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'c',
      played: played('a', 'b'),
      history: ['a', 'b', 'c']
    })

    const next = reduce(state, { type: 'song/ended' })

    expect(next.currentId).toBe('a')
    expect(next.played).toEqual({ a: true })
    expect(next.history).toEqual(['a', 'b', 'c', 'a'])
  })

  it('picks an unplayed song and keeps the finished one played (shuffle)', () => {
    const state = makeState({ shuffle: true, order: ['a', 'b', 'c'], currentId: 'a' })

    const next = playbackReducer(state, { type: 'song/ended' }, () => 0)

    expect(next.currentId).toBe('b')
    expect(isPlayed(next, 'a')).toBe(true)
    expect(isPlayed(next, 'b')).toBe(true)
  })

  it('resets to exactly the new pick when shuffle exhausts the queue', () => {
    const state = makeState({
      shuffle: true,
      order: ['a', 'b', 'c'],
      currentId: 'c',
      played: played('a', 'b')
    })

    const next = playbackReducer(state, { type: 'song/ended' }, () => 1)

    expect(next.currentId).toBe('b')
    expect(next.currentId).not.toBe(state.currentId)
    expect(next.played).toEqual({ b: true })
  })

  it('stops when the queue is empty', () => {
    const state = makeState({ order: [], isPlaying: true })

    const next = reduce(state, { type: 'song/ended' })

    expect(next.currentId).toBeNull()
    expect(next.isPlaying).toBe(false)
  })
})

describe('playbackReducer — transport/next', () => {
  it('advances despite repeat, and leaves the repeat flag on', () => {
    const state = makeState({ order: ['a', 'b'], currentId: 'a', repeat: true, isPlaying: true })

    const next = reduce(state, { type: 'transport/next' })

    expect(next.currentId).toBe('b')
    expect(next.repeat).toBe(true)
    expect(isPlayed(next, 'a')).toBe(true)
  })

  it('starts the first song when nothing is playing yet', () => {
    const next = reduce(makeState({ order: ['a', 'b'] }), { type: 'transport/next' })

    expect(next.currentId).toBe('a')
    expect(isPlayed(next, 'a')).toBe(true)
    expect(next.isPlaying).toBe(true)
  })
})

describe('playbackReducer — transport/prev', () => {
  it('walks back through history, leaving other played flags alone', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'c',
      history: ['a', 'b', 'c'],
      played: played('a', 'c'),
      playToken: 5
    })

    const first = reduce(state, { type: 'transport/prev' })

    expect(first.currentId).toBe('b')
    expect(first.history).toEqual(['a', 'b'])
    expect(first.playToken).toBe(6)
    expect(first.isPlaying).toBe(true)
    expect(first.played).toEqual({ a: true, b: true, c: true })

    const second = reduce(first, { type: 'transport/prev' })

    expect(second.currentId).toBe('a')
    expect(second.history).toEqual(['a'])
    expect(second.playToken).toBe(7)
  })

  it('restarts the current song when history holds nothing earlier', () => {
    const state = makeState({
      order: ['a', 'b'],
      currentId: 'a',
      history: ['a'],
      played: played('a'),
      playToken: 2
    })

    const next = reduce(state, { type: 'transport/prev' })

    expect(next.currentId).toBe('a')
    expect(next.playToken).toBe(3)
    expect(next.isPlaying).toBe(true)
    expect(next.history).toEqual(['a'])
  })

  it('does nothing when no song is current', () => {
    const state = makeState({ order: ['a', 'b'], history: ['a'] })
    expect(reduce(state, { type: 'transport/prev' })).toBe(state)
  })
})

describe('playbackReducer — play, pause and togglePlay', () => {
  const playingState = makeState({
    order: ['a', 'b'],
    currentId: 'a',
    isPlaying: true,
    playToken: 2,
    played: played('a'),
    history: ['a']
  })

  it('changes only isPlaying on play and pause', () => {
    const paused = { ...playingState, isPlaying: false }

    expect(reduce(paused, { type: 'transport/play' })).toEqual({ ...paused, isPlaying: true })
    expect(reduce(playingState, { type: 'transport/pause' })).toEqual({
      ...playingState,
      isPlaying: false
    })
  })

  it('flips isPlaying on toggle while a song is current', () => {
    expect(reduce(playingState, { type: 'transport/togglePlay' })).toEqual({
      ...playingState,
      isPlaying: false
    })
  })

  it('starts the first song like a manual click when nothing is current', () => {
    const state = makeState({ order: ['a', 'b'], played: played('b') })

    const next = reduce(state, { type: 'transport/togglePlay' })

    expect(next.currentId).toBe('a')
    expect(next.isPlaying).toBe(true)
    expect(next.playToken).toBe(1)
    expect(next.played).toEqual({ a: true })
    expect(next.history).toEqual(['a'])
  })

  it('does nothing when nothing is current and the queue is empty', () => {
    const state = makeState({ order: [] })
    expect(reduce(state, { type: 'transport/togglePlay' })).toBe(state)
  })
})

describe('playbackReducer — shuffle and repeat flags', () => {
  const state = makeState({
    order: ['a', 'b'],
    currentId: 'a',
    isPlaying: true,
    playToken: 7,
    played: played('a'),
    history: ['a']
  })

  it('setShuffle flips only the shuffle flag', () => {
    expect(reduce(state, { type: 'transport/setShuffle', value: true })).toEqual({
      ...state,
      shuffle: true
    })
  })

  it('setRepeat flips only the repeat flag', () => {
    expect(reduce(state, { type: 'transport/setRepeat', value: true })).toEqual({
      ...state,
      repeat: true
    })
  })
})

describe('playbackReducer — queue/selected', () => {
  const state = makeState({
    order: ['a', 'b'],
    currentId: 'a',
    isPlaying: true,
    playToken: 4,
    played: played('a'),
    history: ['a']
  })

  it('applies the queue, stops playback and clears history when no song is started', () => {
    const next = reduce(state, {
      type: 'queue/selected',
      queueId: PLAYLIST_QUEUE_ID,
      order: ['x', 'y'],
      shuffle: true,
      repeat: true
    })

    expect(next.queueId).toBe(PLAYLIST_QUEUE_ID)
    expect(next.order).toEqual(['x', 'y'])
    expect(next.shuffle).toBe(true)
    expect(next.repeat).toBe(true)
    expect(next.currentId).toBeNull()
    expect(next.isPlaying).toBe(false)
    expect(next.playToken).toBe(4)
    expect(next.history).toEqual([])
    expect(playedCount(next)).toBe(0)
    expect(next.played).toEqual({})
  })

  it('starts the given song in the new queue instead of stopping', () => {
    const frozen = deepFreeze(structuredClone(state))

    const next = reduce(frozen, {
      type: 'queue/selected',
      queueId: PLAYLIST_QUEUE_ID,
      order: ['x', 'y', 'z'],
      shuffle: false,
      repeat: false,
      startSongId: 'y'
    })

    expect(next.queueId).toBe(PLAYLIST_QUEUE_ID)
    expect(next.order).toEqual(['x', 'y', 'z'])
    expect(next.currentId).toBe('y')
    expect(next.isPlaying).toBe(true)
    expect(next.playToken).toBe(5)
    // `resetPlayed: true`, exactly as a manual click: only the started song counts as played.
    expect(next.played).toEqual({ y: true })
    expect(next.history).toEqual(['y'])
    // The state it was given is untouched.
    expect(frozen).toEqual(state)
  })

  it('drops the flags a re-selected queue had when a song is started in it', () => {
    const playlistPlayed = reduce(state, {
      type: 'queue/selected',
      queueId: PLAYLIST_QUEUE_ID,
      order: ['x', 'y'],
      shuffle: false,
      repeat: false,
      startSongId: 'x'
    })

    const back = reduce(playlistPlayed, {
      type: 'queue/selected',
      queueId: PLAYLIST_QUEUE_ID,
      order: ['x', 'y'],
      shuffle: false,
      repeat: false,
      startSongId: 'y'
    })

    expect(back.played).toEqual({ y: true })
    expect(back.history).toEqual(['y'])
  })

  it('clears the played set on every switch — flags never follow a queue', () => {
    const playlist = reduce(state, {
      type: 'queue/selected',
      queueId: PLAYLIST_QUEUE_ID,
      order: ['x', 'y'],
      shuffle: false,
      repeat: false
    })
    const playing = reduce(playlist, { type: 'song/selected', songId: 'x' })

    const back = reduce(playing, {
      type: 'queue/selected',
      queueId: LIBRARY_QUEUE_ID,
      order: ['a', 'b'],
      shuffle: false,
      repeat: false
    })

    // 'a' was played before the round trip (see `state`); the switch back does not resurrect it.
    expect(isPlayed(back, 'a')).toBe(false)
    expect(playedCount(back)).toBe(0)
    expect(back.played).toEqual({})
  })
})

describe('playbackReducer — queue/orderChanged', () => {
  it('keeps the current song and its flags, dropping ids that left the queue', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'b',
      isPlaying: true,
      played: played('a', 'b', 'c'),
      history: ['a', 'b']
    })

    const next = reduce(state, { type: 'queue/orderChanged', order: ['b', 'c', 'd'] })

    expect(next.order).toEqual(['b', 'c', 'd'])
    expect(next.currentId).toBe('b')
    expect(next.isPlaying).toBe(true)
    expect(next.played).toEqual({ b: true, c: true })
  })

  it('clears the current song when it left the queue', () => {
    const state = makeState({
      order: ['a', 'b'],
      currentId: 'a',
      isPlaying: true,
      played: played('a')
    })

    const next = reduce(state, { type: 'queue/orderChanged', order: ['b'] })

    expect(next.currentId).toBeNull()
    expect(next.isPlaying).toBe(false)
  })

  it('cannot create played flags while no queue is selected', () => {
    const next = reduce(initialPlaybackState(), { type: 'queue/orderChanged', order: ['a', 'b'] })

    expect(next.order).toEqual(['a', 'b'])
    expect(next.currentId).toBeNull()
    expect(next.played).toEqual({})
  })
})

describe('playbackReducer — library/songsRemoved', () => {
  it('strips the ids from the order, the played set and history', () => {
    const state = makeState({
      order: ['a', 'b', 'c'],
      currentId: 'c',
      isPlaying: true,
      history: ['a', 'b', 'c'],
      played: { a: true, b: true, c: true }
    })

    const next = reduce(state, { type: 'library/songsRemoved', songIds: ['a'] })

    expect(next.order).toEqual(['b', 'c'])
    expect(next.history).toEqual(['b', 'c'])
    expect(next.played).toEqual({ b: true, c: true })
    expect(next.currentId).toBe('c')
    expect(next.isPlaying).toBe(true)
  })

  it('stops playback when the current song is removed', () => {
    const state = makeState({
      order: ['a', 'b'],
      currentId: 'a',
      isPlaying: true,
      played: played('a')
    })

    const next = reduce(state, { type: 'library/songsRemoved', songIds: ['a'] })

    expect(next.currentId).toBeNull()
    expect(next.isPlaying).toBe(false)
    expect(next.order).toEqual(['b'])
  })
})

describe('playbackReducer — playlists/removed', () => {
  /**
   * A deleted playlist must not stay the queue: everything downstream reads `queueId` as a live id
   * — the toggles write shuffle and repeat back to it — so a dead one is worse than no queue at all.
   */
  it('empties the queue when the playlist that owns it is deleted', () => {
    const state = makeState({
      queueId: PLAYLIST_QUEUE_ID,
      order: ['a', 'b'],
      currentId: 'a',
      isPlaying: true,
      history: ['a'],
      played: { a: true }
    })

    const next = reduce(state, { type: 'playlists/removed', playlistId: PLAYLIST_QUEUE_ID })

    expect(next.queueId).toBeNull()
    expect(next.order).toEqual([])
    expect(next.currentId).toBeNull()
    expect(next.isPlaying).toBe(false)
    expect(next.history).toEqual([])
    expect(next.played).toEqual({})
  })

  /** Another playlist's deletion is none of playback's business now that flags are current-queue only. */
  it('ignores the deletion of a playlist that is not the queue', () => {
    const state = makeState({
      queueId: PLAYLIST_QUEUE_ID,
      order: ['a'],
      currentId: 'a',
      isPlaying: true,
      played: { a: true }
    })

    expect(reduce(state, { type: 'playlists/removed', playlistId: 'other' })).toBe(state)
  })
})

describe('playbackReducer — history', () => {
  it('caps history at 100 entries, dropping the oldest', () => {
    const order = Array.from({ length: 120 }, (_, index) => `s${index}`)

    let state = makeState({ order })
    for (const songId of order) state = reduce(state, { type: 'song/selected', songId })

    expect(state.history).toHaveLength(100)
    expect(state.history[0]).toBe('s20')
    expect(state.history.at(-1)).toBe('s119')
  })

  it('does not record an entry when the same song starts again', () => {
    const state = makeState({
      order: ['a'],
      currentId: 'a',
      history: ['a'],
      played: played('a')
    })

    const next = reduce(state, { type: 'transport/next' })

    expect(next.currentId).toBe('a')
    expect(next.history).toEqual(['a'])
    expect(next.playToken).toBe(1)
  })
})

describe('createPlaybackReducer', () => {
  const shuffling = makeState({
    shuffle: true,
    order: ['a', 'b', 'c'],
    currentId: 'a',
    played: played('a')
  })

  it('binds the injected rng', () => {
    const rng = vi.fn<Rng>(() => 1)

    const next = createPlaybackReducer(rng)(shuffling, { type: 'transport/next' })

    expect(next.currentId).toBe('c')
    expect(rng).toHaveBeenCalledWith(2)
  })

  it('falls back to the default rng', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect(createPlaybackReducer()(shuffling, { type: 'transport/next' }).currentId).toBe('b')
  })
})

/** One of every action type, for the table-driven invariant and immutability checks. */
const EVERY_ACTION: readonly PlaybackAction[] = [
  {
    type: 'queue/selected',
    queueId: PLAYLIST_QUEUE_ID,
    order: ['x', 'y'],
    shuffle: true,
    repeat: false
  },
  { type: 'queue/orderChanged', order: ['b', 'c', 'd'] },
  { type: 'song/selected', songId: 'c' },
  { type: 'song/ended' },
  { type: 'transport/next' },
  { type: 'transport/prev' },
  { type: 'transport/play' },
  { type: 'transport/pause' },
  { type: 'transport/togglePlay' },
  { type: 'transport/setShuffle', value: true },
  { type: 'transport/setRepeat', value: true },
  { type: 'library/songsRemoved', songIds: ['b'] },
  { type: 'playlists/removed', playlistId: PLAYLIST_QUEUE_ID }
]

const INVARIANT_BASES: readonly [string, PlaybackState][] = [
  [
    'mid-queue',
    makeState({
      order: ['a', 'b', 'c'],
      currentId: 'b',
      isPlaying: true,
      playToken: 3,
      played: played('a', 'b'),
      history: ['a', 'b']
    })
  ],
  ['idle', makeState({ order: ['a', 'b', 'c'] })],
  [
    'last song, shuffled and exhausted',
    makeState({
      shuffle: true,
      order: ['a', 'b', 'c'],
      currentId: 'c',
      isPlaying: true,
      played: played('a', 'b', 'c'),
      history: ['a', 'b', 'c']
    })
  ],
  ['repeating', makeState({ order: ['a'], currentId: 'a', repeat: true, played: played('a') })],
  // A playlist queue, so the actions keyed by queue id are exercised against the queue they name.
  [
    'playlist queue',
    makeState({
      queueId: PLAYLIST_QUEUE_ID,
      order: ['a', 'b', 'c'],
      currentId: 'b',
      isPlaying: true,
      played: { a: true, b: true },
      history: ['a', 'b']
    })
  ]
]

describe('playbackReducer — invariants', () => {
  it.each(EVERY_ACTION)('leaves the current song marked played after $type', (action) => {
    for (const [label, base] of INVARIANT_BASES) {
      const next = playbackReducer(base, action, () => 0)
      const holds = next.currentId === null || isPlayed(next, next.currentId)
      expect(holds, `${action.type} from "${label}" left ${next.currentId} unplayed`).toBe(true)
    }
  })

  it('never mutates the state it is given', () => {
    for (const [, base] of INVARIANT_BASES) {
      for (const action of EVERY_ACTION) {
        const frozen = deepFreeze(structuredClone(base))
        const snapshot = structuredClone(base)

        expect(() => playbackReducer(frozen, action, () => 0)).not.toThrow()
        expect(frozen).toEqual(snapshot)
      }
    }
  })
})

function deepFreeze<T>(value: T): T {
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested)
  }
  return Object.freeze(value)
}
