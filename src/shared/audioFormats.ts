
export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm'
}

// Audio file extensions
export const AUDIO_EXTENSIONS: readonly string[] = Object.keys(MIME_TYPES).map((ext) =>
  ext.slice(1)
)

// Audio file labels with proper name
const LABEL_OVERRIDES: Readonly<Record<string, string>> = { opus: 'Opus', webm: 'WebM' }

// Main file format to be used
export const AUDIO_FORMAT_LABELS: readonly string[] = AUDIO_EXTENSIONS.map(
  (ext) => LABEL_OVERRIDES[ext] ?? ext.toUpperCase()
)
