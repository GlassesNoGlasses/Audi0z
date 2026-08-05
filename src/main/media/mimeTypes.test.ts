import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTENT_TYPE, MIME_TYPES, contentTypeFor } from './mimeTypes'

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
