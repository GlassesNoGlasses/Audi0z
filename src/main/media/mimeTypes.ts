import path from 'node:path'
import { AUDIO_EXTENSIONS, MIME_TYPES } from '../../shared/audioFormats'

/**
 * Main's half of the audio-format catalogue: what to label a `media://` response, and the two
 * answers that follow from it — whether a file is playable at all, and what the OS picker offers.
 *
 * The catalogue itself lives in `shared/audioFormats.ts` so the renderer can read it too; the
 * `node:path` below is why this half cannot follow it there. Chromium sniffs most of these types
 * anyway, but a wrong or missing `Content-Type` on a `media://` response is enough to make
 * `<audio>` refuse to play.
 */

// Re-exported so the protocol side has one import for the whole content-type story.
export { MIME_TYPES }

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

export function contentTypeFor(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}

/**
 * Whether the app can actually play this file. The protocol's fallback *is* the definition: a file
 * served as `application/octet-stream` is one `<audio>` refuses, so it must never be imported.
 */
export function isPlayableFile(fileName: string): boolean {
  return contentTypeFor(fileName) !== DEFAULT_CONTENT_TYPE
}

/** Electron's `FileFilter`, redeclared so this module needs no `electron` import. */
interface AudioFileFilter {
  name: string
  extensions: string[]
}

/**
 * What the file picker offers. It lives here rather than at the `showOpenDialog` call site because
 * it is a decision, and decisions get a test.
 *
 * "All files" stays: a correctly encoded file with an odd name is still the user's to add, and
 * `library:add` is what turns the genuinely unplayable away.
 */
export const AUDIO_FILE_FILTERS: readonly AudioFileFilter[] = [
  { name: 'Audio', extensions: [...AUDIO_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] }
]
