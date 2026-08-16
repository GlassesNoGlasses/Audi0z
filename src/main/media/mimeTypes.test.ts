import { describe, expect, it } from 'vitest'
import { AUDIO_EXTENSIONS } from '../../shared/audioFormats'
import {
  AUDIO_FILE_FILTERS,
  DEFAULT_CONTENT_TYPE,
  MIME_TYPES,
  contentTypeFor,
  isPlayableFile
} from './mimeTypes'

describe('contentTypeFor', () => {
  it.each([
    ['song.wav', 'audio/wav'],
    ['song.opus', 'audio/ogg'],
    ['song.mp3', 'audio/mpeg'],
    ['song.m4a', 'audio/mp4'],
    ['song.aac', 'audio/aac'],
    ['song.flac', 'audio/flac'],
    ['song.ogg', 'audio/ogg'],
    ['song.webm', 'audio/webm']
  ])('maps %s to %s', (fileName, expected) => {
    expect(contentTypeFor(fileName)).toBe(expected)
  })

  it('is case-insensitive about the extension', () => {
    expect(contentTypeFor('SONG.WAV')).toBe('audio/wav')
    expect(contentTypeFor('Song.Opus')).toBe('audio/ogg')
  })

  it('falls back to application/octet-stream', () => {
    expect(contentTypeFor('song.aiff')).toBe(DEFAULT_CONTENT_TYPE)
    expect(contentTypeFor('no-extension')).toBe(DEFAULT_CONTENT_TYPE)
    expect(contentTypeFor('')).toBe(DEFAULT_CONTENT_TYPE)
    expect(DEFAULT_CONTENT_TYPE).toBe('application/octet-stream')
  })

  it('keys the map by dotted, lower-case extension', () => {
    expect(Object.keys(MIME_TYPES).every((key) => key === key.toLowerCase())).toBe(true)
    expect(Object.keys(MIME_TYPES).every((key) => key.startsWith('.'))).toBe(true)
  })
})

describe('isPlayableFile', () => {
  it.each([...AUDIO_EXTENSIONS])('accepts a .%s file', (ext) => {
    expect(isPlayableFile(`song.${ext}`)).toBe(true)
  })

  it.each(['song.aiff', 'song.wma', 'song.mp4', 'notes.txt', 'no-extension', ''])(
    'rejects "%s"',
    (fileName) => {
      expect(isPlayableFile(fileName)).toBe(false)
    }
  )
})

/** The one filter the Audio entry offers; the escape hatch is checked separately. */
function audioExtensions(): readonly string[] {
  const audio = AUDIO_FILE_FILTERS.find((filter) => filter.name === 'Audio')
  if (!audio) throw new Error('the picker offers no Audio filter')
  return audio.extensions
}

describe('AUDIO_FILE_FILTERS', () => {
  it('offers only extensions the protocol can label', () => {
    for (const ext of audioExtensions()) expect(isPlayableFile(`song.${ext}`)).toBe(true)
  })

  it('offers every extension the catalogue knows', () => {
    expect([...audioExtensions()].sort()).toEqual([...AUDIO_EXTENSIONS].sort())
  })

  // The v3.4 regression pin: the picker used to offer both, and a file it cannot label is a song
  // that never makes a sound — one the app then mislabels "File missing".
  it.each(['aiff', 'wma'])('does not offer %s, which Chromium cannot play', (ext) => {
    expect(audioExtensions()).not.toContain(ext)
    expect(isPlayableFile(`song.${ext}`)).toBe(false)
  })

  it('keeps the all-files escape hatch, last', () => {
    expect(AUDIO_FILE_FILTERS.at(-1)).toEqual({ name: 'All files', extensions: ['*'] })
  })
})
