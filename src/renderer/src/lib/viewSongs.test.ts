import { describe, expect, it } from 'vitest'
import { playlist, song } from '../testing/harness'
import { songsInView, viewedPlaylist } from './viewSongs'

const songs = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')]
const mixes = playlist('p1', 'Mixes', ['c', 'a'])

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
    expect(songsInView(songs, null, { kind: 'library' })).toEqual(songs)
  })

  it("is the playlist in the playlist's own order", () => {
    const inView = songsInView(songs, mixes, { kind: 'playlist', id: 'p1' })
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('is empty when the viewed playlist is gone', () => {
    expect(songsInView(songs, null, { kind: 'playlist', id: 'p9' })).toEqual([])
  })

  /** A playlist can name a song that was deleted between two reads; a hole is not a row. */
  it('drops ids the library no longer knows', () => {
    const stale = playlist('p1', 'Mixes', ['c', 'gone', 'a'])
    const inView = songsInView(songs, stale, { kind: 'playlist', id: 'p1' })
    expect(inView.map((entry) => entry.id)).toEqual(['c', 'a'])
  })
})
