/** A real, playable WAV in memory: 8 kHz mono 8-bit PCM, what ffmpeg and Chromium both accept. */

export const WAV_SAMPLE_RATE = 8000
export const WAV_CHANNELS = 1
export const WAV_BITS_PER_SAMPLE = 8

const TONE_HZ = 440

/** @returns a complete RIFF/WAVE buffer (44-byte header + PCM data). */
export function makeWav(durationSec = 0.5): Buffer {
  const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8
  const byteRate = WAV_SAMPLE_RATE * blockAlign
  const sampleCount = Math.round(WAV_SAMPLE_RATE * durationSec)
  const dataSize = sampleCount * blockAlign

  const data = Buffer.alloc(dataSize)
  for (let i = 0; i < sampleCount; i++) {
    // 8-bit PCM is unsigned: 128 is silence, 0 and 255 are the rails.
    const value = Math.sin((2 * Math.PI * TONE_HZ * i) / WAV_SAMPLE_RATE)
    data.writeUInt8(Math.max(0, Math.min(255, Math.round(128 + value * 100))), i)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4) // everything after this field
  header.write('WAVE', 8, 'ascii')

  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk body size
  header.writeUInt16LE(1, 20) // audio format: PCM
  header.writeUInt16LE(WAV_CHANNELS, 22)
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34)

  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, data])
}
