import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompressionSaving,
  formatDate,
  formatDuration,
  OPUS_BYTES_PER_SEC,
  readableTextColor
} from './format'

describe('formatBytes', () => {
  it('says a dash when there is no size to show', () => {
    expect(formatBytes(null)).toBe('—')
  })

  it('counts whole bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('steps up a unit at a time, to one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB')
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
  })

  it('stops at gigabytes rather than inventing a bigger unit', () => {
    expect(formatBytes(2048 * 1024 ** 3)).toBe('2048.0 GB')
  })
})

describe('formatDuration', () => {
  it('says a placeholder while the duration is unknown', () => {
    expect(formatDuration(undefined)).toBe('–:––')
    expect(formatDuration(Number.NaN)).toBe('–:––')
    expect(formatDuration(-1)).toBe('–:––')
  })

  /** The transport shows an unreported time as the start of the song, not as an unknown one. */
  it('says the placeholder the caller hands over instead', () => {
    expect(formatDuration(undefined, '0:00')).toBe('0:00')
    expect(formatDuration(Number.NaN, '0:00')).toBe('0:00')
    expect(formatDuration(-1, '0:00')).toBe('0:00')
  })

  it('leaves a real duration alone whatever the fallback is', () => {
    expect(formatDuration(173, '0:00')).toBe('2:53')
    expect(formatDuration(0, '0:00')).toBe('0:00')
  })

  it('reads as minutes and zero-padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(173)).toBe('2:53')
    expect(formatDuration(173.9)).toBe('2:53')
    // Past an hour it keeps counting minutes rather than growing a third field.
    expect(formatDuration(3725)).toBe('62:05')
  })
})

describe('formatDate', () => {
  it('writes the local-time date as MM/DD/YYYY', () => {
    // Built from local-time parts, so the expectation holds in every timezone.
    expect(formatDate(new Date(2024, 0, 15, 12, 30).toISOString())).toBe('01/15/2024')
    expect(formatDate(new Date(2025, 11, 3, 8, 0).toISOString())).toBe('12/03/2025')
  })

  it('says a placeholder while the date is unreadable', () => {
    expect(formatDate('not-a-date')).toBe('––/––/––––')
    expect(formatDate('')).toBe('––/––/––––')
  })
})

describe('formatCompressionSaving', () => {
  it('estimates the saving from the size and the playing time', () => {
    const size = 5 * 1024 * 1024
    const seconds = 120
    expect(size - seconds * OPUS_BYTES_PER_SEC).toBeGreaterThan(0)
    expect(formatCompressionSaving(size, seconds)).toBe('~3.6 MB save')
  })

  it('falls back to the generic figure when either half is unknown', () => {
    expect(formatCompressionSaving(null, undefined)).toBe('Saves ~25%')
    expect(formatCompressionSaving(null, 120)).toBe('Saves ~25%')
    expect(formatCompressionSaving(5 * 1024 * 1024, undefined)).toBe('Saves ~25%')
  })

  /** A file already smaller than Opus would make it has nothing honest to promise. */
  it('falls back to the generic figure when the estimate is not a saving', () => {
    expect(formatCompressionSaving(1_000_000, 120)).toBe('Saves ~25%')
    expect(formatCompressionSaving(120 * OPUS_BYTES_PER_SEC, 120)).toBe('Saves ~25%')
  })
})

describe('readableTextColor', () => {
  it('picks the ink that stands out against the chip', () => {
    expect(readableTextColor('#ffffff')).toBe('#000000')
    expect(readableTextColor('#000000')).toBe('#ffffff')
    expect(readableTextColor('#e0a35c')).toBe('#000000')
    expect(readableTextColor('#3b2f8f')).toBe('#ffffff')
  })

  it('accepts either case', () => {
    expect(readableTextColor('#FFFFFF')).toBe('#000000')
  })

  /** Colours come from a JSON file a user can hand-edit, so a broken one must not throw. */
  it('assumes a dark chip when the colour is not a hex triplet', () => {
    expect(readableTextColor('rebeccapurple')).toBe('#ffffff')
  })
})
