import path from 'node:path'

/**
 * Content types for the audio the app can hold: whatever the user imported, plus the Opus files
 * the optional transcode produces. Chromium sniffs most of these anyway, but a wrong or missing
 * `Content-Type` on a `media://` response is enough to make `<audio>` refuse to play.
 */

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  // Opus is served in an Ogg container — `audio/opus` is not a registered type.
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm'
}

export function contentTypeFor(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}
