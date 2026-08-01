import { describe, expect, it } from 'vitest'
import { makeWav, WAV_BITS_PER_SAMPLE, WAV_CHANNELS, WAV_SAMPLE_RATE } from './makeWav'

const HEADER_BYTES = 44

describe('makeWav', () => {
  it('emits a RIFF/WAVE container', () => {
    const wav = makeWav()
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
  })

  it('declares a RIFF chunk size that matches the actual byte length', () => {
    const wav = makeWav()
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
  })

  it('declares a data chunk length consistent with the header and the buffer', () => {
    const wav = makeWav()
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(wav.length - HEADER_BYTES)
  })

  it('describes 0.5s of 8kHz mono 8-bit PCM by default', () => {
    const wav = makeWav()
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk body size
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(WAV_CHANNELS)
    expect(wav.readUInt32LE(24)).toBe(WAV_SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(WAV_BITS_PER_SAMPLE)
    expect(wav.length).toBe(HEADER_BYTES + WAV_SAMPLE_RATE / 2)
  })

  it('keeps byte rate and block align consistent with the format', () => {
    const wav = makeWav()
    const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8
    expect(wav.readUInt16LE(32)).toBe(blockAlign)
    expect(wav.readUInt32LE(28)).toBe(WAV_SAMPLE_RATE * blockAlign)
  })

  it('honours a custom duration', () => {
    const wav = makeWav(0.25)
    expect(wav.readUInt32LE(40)).toBe(WAV_SAMPLE_RATE / 4)
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
  })

  it('produces actual audio rather than silence', () => {
    const samples = new Set(makeWav().subarray(HEADER_BYTES))
    expect(samples.size).toBeGreaterThan(1)
  })
})
