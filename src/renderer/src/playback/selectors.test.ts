import { describe, expect, it } from 'vitest'
import type { SongDto } from '../../../shared/types'
import { currentIndex, currentSong, isPlayed, playedCount } from './selectors'
import { LIBRARY_QUEUE_ID } from './types'
import type { PlaybackState } from './types'

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    queueId: LIBRARY_QUEUE_ID,
    order: ['a', 'b', 'c'],
    currentId: null,
    played: {},
    history: [],
    shuffle: false,
    repeat: false,
    isPlaying: false,
    playToken: 0,
    ...overrides
  }
}

/** Only the id is ever read here; the rest is what a DTO has to carry to be one. */
function makeSong(id: string): SongDto {
  return {
    id,
    fileName: `${id}.wav`,
    title: id.toUpperCase(),
    tags: [],
    addedAt: '2024-01-01T00:00:00.000Z',
    compressed: false,
    exists: true,
    url: `media://audio/${id}`,
    sizeBytes: 1
  }
}

describe('currentSong', () => {
  it('is the DTO the current id names', () => {
    const songs = [makeSong('a'), makeSong('b')]
    expect(currentSong(songs, makeState({ currentId: 'b' }))).toBe(songs[1])
  })

  it('is null with nothing cued, and when the song has left the library', () => {
    const songs = [makeSong('a')]
    expect(currentSong(songs, makeState())).toBeNull()
    expect(currentSong(songs, makeState({ currentId: 'gone' }))).toBeNull()
  })
})

describe('isPlayed', () => {
  it('reports membership of the played set', () => {
    const state = makeState({ played: { a: true } })
    expect(isPlayed(state, 'a')).toBe(true)
    expect(isPlayed(state, 'b')).toBe(false)
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
  it('counts the played set', () => {
    expect(playedCount(makeState({ played: { a: true, b: true } }))).toBe(2)
    expect(playedCount(makeState())).toBe(0)
  })
})
