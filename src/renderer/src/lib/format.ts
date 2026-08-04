/**
 * Turning numbers into the short strings the UI shows.
 *
 * Everything here is pure and total: these are read by render functions, so a value that is
 * missing, NaN or malformed has to come back as a placeholder rather than as an exception.
 */

/** Powers of 1024, labelled the way a file manager labels them. */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** Shown wherever a size is unknown — the file is gone, or nothing has measured it yet. */
const NO_SIZE = '—'

/** Shown wherever a playing time is unknown, shaped like the `m:ss` it stands in for. */
const NO_DURATION = '–:––'

/** Compressing is quoted as this much when there is nothing to compute a real estimate from. */
export const GENERIC_SAVINGS_PERCENT = 50

/** What a second of the Opus 128 kbit/s the importer transcodes to costs on disk. */
export const OPUS_BYTES_PER_SEC = 16_000

/**
 * `4194304` -> `'4.0 MB'`, `512` -> `'512 B'`, `null` -> `'—'`.
 *
 * Whole bytes below a kilobyte (a decimal on 512 bytes says nothing), one decimal above it, and no
 * unit past GB — a music library that needs terabytes is not the case worth code.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return NO_SIZE

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/** `173` -> `'2:53'`. Minutes keep counting past an hour rather than growing a third field. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return NO_DURATION
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * What compressing this song would save: `'~3.2 MB save'` when the size and the playing time make
 * a real estimate, and the generic `'Saves ~50%'` whenever they do not.
 *
 * The estimate is what the file weighs now minus what Opus 128k would weigh for the same playing
 * time. A song already at or below that — an Opus file imported uncompressed, say — has no saving
 * to promise, so it falls back rather than quoting a negative one.
 */
export function formatCompressionSaving(
  sizeBytes: number | null,
  durationSec: number | undefined
): string {
  const generic = `Saves ~${GENERIC_SAVINGS_PERCENT}%`
  if (sizeBytes === null || durationSec === undefined) return generic
  const saved = sizeBytes - durationSec * OPUS_BYTES_PER_SEC
  return saved > 0 ? `~${formatBytes(saved)} save` : generic
}

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

/**
 * Black or white ink, whichever a tag's own colour can be read against.
 *
 * WCAG relative luminance, thresholded where black and white contrast equally (L ≈ 0.179) — the
 * point above which black wins. Colours are persisted JSON a user can hand-edit, so anything that
 * is not a `#rrggbb` triplet is treated as dark and gets white.
 */
export function readableTextColor(hex: string): string {
  const match = HEX_COLOR.exec(hex)
  if (!match) return '#ffffff'

  const [red, green, blue] = match.slice(1, 4).map((pair) => {
    const channel = Number.parseInt(pair, 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.179 ? '#000000' : '#ffffff'
}
