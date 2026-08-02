import { describe, expect, it } from 'vitest'
import { parseTags, titleFromPath } from './text'

describe('titleFromPath', () => {
  it('takes the file name without its extension', () => {
    expect(titleFromPath('/music/Great Track.mp3')).toBe('Great Track')
    expect(titleFromPath('C:\\music\\Great Track.flac')).toBe('Great Track')
  })

  it('leaves an extensionless name alone', () => {
    expect(titleFromPath('/music/Great Track')).toBe('Great Track')
  })
})

describe('parseTags', () => {
  it('trims and drops the empties', () => {
    expect(parseTags(' slowed , , reverb ,')).toEqual(['slowed', 'reverb'])
    expect(parseTags('   ')).toEqual([])
  })
})
