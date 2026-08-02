import { describe, expect, it } from 'vitest'
import { filterSongs } from './search'

interface TestSong {
  title: string
  tags: string[]
}

const SONGS: TestSong[] = [
  { title: 'Midnight City', tags: ['synthwave', 'night'] },
  { title: 'MIDNIGHT rain', tags: ['slowed', 'sad'] },
  { title: 'Sunrise Mashup', tags: ['mashup', 'night drive'] }
]

describe('filterSongs', () => {
  it('returns every song, in order, for an empty or whitespace query', () => {
    for (const query of ['', '   ']) {
      const result = filterSongs(SONGS, query)
      expect(result).toEqual(SONGS)
      expect(result).not.toBe(SONGS)
    }
  })

  it('matches titles case-insensitively, on any substring', () => {
    expect(filterSongs(SONGS, 'NIGHT c')).toEqual([SONGS[0]])
    expect(filterSongs(SONGS, 'midnight')).toEqual([SONGS[0], SONGS[1]])
  })

  it('matches any tag', () => {
    expect(filterSongs(SONGS, 'slowed')).toEqual([SONGS[1]])
  })

  it('requires every term to match, in the title or in any tag', () => {
    expect(filterSongs(SONGS, 'midnight synthwave')).toEqual([SONGS[0]])
    expect(filterSongs(SONGS, 'mashup night')).toEqual([SONGS[2]])
    expect(filterSongs(SONGS, '  sunrise   drive  ')).toEqual([SONGS[2]])
  })

  it('returns nothing when a term matches no song', () => {
    expect(filterSongs(SONGS, 'midnight polka')).toEqual([])
  })

  it('never mutates the songs it is given', () => {
    const songs = Object.freeze([Object.freeze({ title: 'Midnight City', tags: ['synthwave'] })])

    expect(() => filterSongs(songs, 'midnight')).not.toThrow()
    expect(songs).toEqual([{ title: 'Midnight City', tags: ['synthwave'] }])
  })
})
