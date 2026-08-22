import { describe, expect, it } from 'vitest'
import { SortDirection, SortType, type SortMode } from '../state/appReducer'
import { playlist, song } from '../testing/harness'
import { mergeReorderedIds, songsInView, sortSongs, viewedPlaylist } from './viewSongs'

const songs = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')]
const mixes = playlist('p1', 'Mixes', ['c', 'a'])

/** Stored order a, b, c; oldest is b and newest a; Charlie is the one nobody has measured. */
const dated = [
  song('a', 'Alpha', { addedAt: '2024-03-01T00:00:00.000Z', durationSec: 200 }),
  song('b', 'Bravo', { addedAt: '2024-01-01T00:00:00.000Z', durationSec: 100 }),
  song('c', 'Charlie', { addedAt: '2024-02-01T00:00:00.000Z' })
]

const customOrder: SortMode = { type: SortType.CUSTOM, direction: SortDirection.ASC }

const newestFirst: SortMode = { type: SortType.DATEADDED, direction: SortDirection.DESC }

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
    expect(songsInView(songs, null, { kind: 'library' }, customOrder)).toEqual(songs)
  })

  it("is the playlist in the playlist's own order", () => {
    const inView = songsInView(songs, mixes, { kind: 'playlist', id: 'p1' }, customOrder)
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('is empty when the viewed playlist is gone', () => {
    expect(songsInView(songs, null, { kind: 'playlist', id: 'p9' }, customOrder)).toEqual([])
  })

  /** A playlist can name a song that was deleted between two reads; a hole is not a row. */
  it('drops ids the library no longer knows', () => {
    const stale = playlist('p1', 'Mixes', ['c', 'gone', 'a'])
    const inView = songsInView(songs, stale, { kind: 'playlist', id: 'p1' }, customOrder)
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('orders the Library view by the sort in force', () => {
    expect(ids(songsInView(dated, null, { kind: 'library' }, newestFirst))).toEqual(['a', 'c', 'b'])
  })

  it('orders a playlist view out of the order the playlist stores', () => {
    const inView = songsInView(dated, mixes, { kind: 'playlist', id: 'p1' }, newestFirst)
    expect(ids(inView)).toEqual(['a', 'c'])
  })
})

describe('sortSongs', () => {
  it('leaves the stored order alone under Custom Order', () => {
    expect(sortSongs(dated, customOrder)).toBe(dated)
    // Whatever the direction says: Custom Order has no axis for it to flip.
    expect(sortSongs(dated, { type: SortType.CUSTOM, direction: SortDirection.DESC })).toBe(dated)
  })

  it('orders by date added in either direction', () => {
    expect(
      ids(sortSongs(dated, { type: SortType.DATEADDED, direction: SortDirection.ASC }))
    ).toEqual(['b', 'c', 'a'])
    expect(
      ids(sortSongs(dated, { type: SortType.DATEADDED, direction: SortDirection.DESC }))
    ).toEqual(['a', 'c', 'b'])
  })

  /** Case must not split the alphabet, and numbers must count: "Track 2" before "Track 10". */
  it('orders by title like a human list, not by code unit', () => {
    const titled = [
      song('z', 'Zebra Mix'),
      song('a', 'apple bounce'),
      song('t10', 'Track 10'),
      song('t2', 'Track 2')
    ]
    expect(ids(sortSongs(titled, { type: SortType.TITLE, direction: SortDirection.ASC }))).toEqual([
      'a',
      't2',
      't10',
      'z'
    ])
    expect(ids(sortSongs(titled, { type: SortType.TITLE, direction: SortDirection.DESC }))).toEqual(
      ['z', 't10', 't2', 'a']
    )
  })

  /** An unmeasured song has nothing to sort by, so it sinks whichever way the sort runs. */
  it('orders by duration with unmeasured songs sinking in both directions', () => {
    expect(
      ids(sortSongs(dated, { type: SortType.DURATION, direction: SortDirection.ASC }))
    ).toEqual(['b', 'a', 'c'])
    expect(
      ids(sortSongs(dated, { type: SortType.DURATION, direction: SortDirection.DESC }))
    ).toEqual(['a', 'b', 'c'])
  })

  /** Size's unknown is `null`, the DTO's "the file is gone" marker. */
  it('orders by size with unmeasured songs sinking in both directions', () => {
    const sized = [
      song('big', 'Big', { sizeBytes: 9000 }),
      song('gone', 'Gone', { sizeBytes: null }),
      song('small', 'Small', { sizeBytes: 100 })
    ]
    expect(ids(sortSongs(sized, { type: SortType.SIZE, direction: SortDirection.ASC }))).toEqual([
      'small',
      'big',
      'gone'
    ])
    expect(ids(sortSongs(sized, { type: SortType.SIZE, direction: SortDirection.DESC }))).toEqual([
      'big',
      'small',
      'gone'
    ])
  })

  it('does not mutate its input', () => {
    const before = ids(dated)
    sortSongs(dated, { type: SortType.DURATION, direction: SortDirection.DESC })
    expect(ids(dated)).toEqual(before)
  })
})

describe('mergeReorderedIds', () => {
  it('threads the dragged order through the known ids', () => {
    expect(mergeReorderedIds(['a', 'b', 'c'], ['c', 'a', 'b'], new Set(['a', 'b', 'c']))).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('keeps ids the library cannot resolve at their stored positions', () => {
    expect(mergeReorderedIds(['a', 'ghost', 'b'], ['b', 'a'], new Set(['a', 'b']))).toEqual([
      'b',
      'ghost',
      'a'
    ])
  })
})
