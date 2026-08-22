/**
 * Turning numbers into the short strings the UI shows.
 *
 * Pure and total: these run inside render, so a missing, NaN or malformed value has to come back
 * as a placeholder rather than as an exception.
 */

/** Powers of 1024, labelled the way a file manager labels them. */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** Shown wherever a size is unknown — the file is gone, or nothing has measured it yet. */
const NO_SIZE = '—'

/** Shown wherever a playing time is unknown, shaped like the `m:ss` it stands in for. */
const NO_DURATION = '–:––'

/** Shown wherever an added-date is unknown — shaped like the MM/DD/YYYY it stands in for. */
const NO_DATE = '––/––/––––'

/** ~what 96k Opus takes off a ~128k download when there's no real estimate. */
export const GENERIC_SAVINGS_PERCENT = 25

/** What a second of the Opus 96 kbit/s the importer transcodes to costs on disk. */
export const OPUS_BYTES_PER_SEC = 12_000

/** `4194304` -> `'4.0 MB'`, `512` -> `'512 B'`, `null` -> `'—'`; whole bytes under a KB, caps at GB. */
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

/** `173` -> `'2:53'`, minutes counting past an hour; `fallback` covers missing/NaN/negative. */
export function formatDuration(seconds: number | undefined, fallback = NO_DURATION): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return fallback
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/** The added-date as MM/DD/YYYY in the user's own clock — the stamp itself is stored UTC. */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return NO_DATE
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}/${day}/${date.getFullYear()}`
}

/** `'~3.6 MB save'` from size minus Opus 96k, or the generic `'Saves ~25%'` when that is unknown or ≤ 0. */
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

/** Black or white ink by WCAG relative luminance, thresholded at L ≈ 0.179; non-`#rrggbb` gets white. */
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
