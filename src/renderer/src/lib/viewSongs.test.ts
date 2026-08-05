import { describe, expect, it } from 'vitest'
import type { SortMode } from '../state/appReducer'
import { playlist, song } from '../testing/harness'
import { songsInView, sortSongs, viewedPlaylist } from './viewSongs'

const songs = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')]
const mixes = playlist('p1', 'Mixes', ['c', 'a'])

/** Stored order a, b, c; oldest is b and newest a; Charlie is the one nobody has measured. */
const dated = [
  song('a', 'Alpha', { addedAt: '2024-03-01T00:00:00.000Z', durationSec: 200 }),
  song('b', 'Bravo', { addedAt: '2024-01-01T00:00:00.000Z', durationSec: 100 }),
  song('c', 'Charlie', { addedAt: '2024-02-01T00:00:00.000Z' })
]

const newestFirst: SortMode = { field: 'addedAt', direction: 'desc' }

function ids(entries: { id: string }[]): string[] {
  return entries.map((entry) => entry.id)
}

describe('viewedPlaylist', () => {
  it('has no playlist in the Library view', () => {
    expect(viewedPlaylist({ kind: 'library' }, [mixes])).toBeNull()
  })

  it('finds the playlist being viewed', () => {
    expect(viewedPlaylist({ kind: 'playlist', id: 'p1' }, [mixes])).toBe(mixes)
  })

  it('has no playlist when the viewed one is gone', () => {
    expect(viewedPlaylist({ kind: 'playlist', id: 'p9' }, [mixes])).toBeNull()
  })
})

describe('songsInView', () => {
  it('is the whole library in the Library view', () => {
    expect(songsInView(songs, null, { kind: 'library' }, null)).toEqual(songs)
  })

  it("is the playlist in the playlist's own order", () => {
    const inView = songsInView(songs, mixes, { kind: 'playlist', id: 'p1' }, null)
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('is empty when the viewed playlist is gone', () => {
    expect(songsInView(songs, null, { kind: 'playlist', id: 'p9' }, null)).toEqual([])
  })

  /** A playlist can name a song that was deleted between two reads; a hole is not a row. */
  it('drops ids the library no longer knows', () => {
    const stale = playlist('p1', 'Mixes', ['c', 'gone', 'a'])
    const inView = songsInView(songs, stale, { kind: 'playlist', id: 'p1' }, null)
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('orders the Library view by the sort in force', () => {
    expect(ids(songsInView(dated, null, { kind: 'library' }, newestFirst))).toEqual(['a', 'c', 'b'])
  })

  /** The sort outranks the playlist's own order — that is what the user asked for. */
  it('orders a playlist view out of the order the playlist stores', () => {
    const inView = songsInView(dated, mixes, { kind: 'playlist', id: 'p1' }, newestFirst)
    expect(ids(inView)).toEqual(['a', 'c'])
  })
})

describe('sortSongs', () => {
  it('leaves the stored order alone with no sort', () => {
    expect(sortSongs(dated, null)).toBe(dated)
  })

  it('orders by date added in either direction', () => {
    expect(ids(sortSongs(dated, { field: 'addedAt', direction: 'asc' }))).toEqual(['b', 'c', 'a'])
    expect(ids(sortSongs(dated, { field: 'addedAt', direction: 'desc' }))).toEqual(['a', 'c', 'b'])
  })

  /**
   * A song nobody has measured has nothing to sort by, so it goes to the end whichever way the
   * sort runs — flipping the direction must not float the unknowns to the top of the list.
   */
  it('orders by duration with unmeasured songs sinking in both directions', () => {
    expect(ids(sortSongs(dated, { field: 'durationSec', direction: 'asc' }))).toEqual([
      'b',
      'a',
      'c'
    ])
    expect(ids(sortSongs(dated, { field: 'durationSec', direction: 'desc' }))).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('does not mutate its input', () => {
    const before = ids(dated)
    sortSongs(dated, { field: 'durationSec', direction: 'desc' })
    expect(ids(dated)).toEqual(before)
  })
})
