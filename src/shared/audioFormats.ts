/**
 * The audio formats the app accepts, in one place — every other list is derived from this one.
 *
 * The list used to be spelled out four times (the OS picker's filter, this mime map, the add
 * dialog's hint, the README) at three different lengths, and the drift had already happened: the
 * picker offered `aiff` and `wma`, which the `media://` protocol cannot label, so those files
 * imported fine, played nothing, and left the app calling a file that is sitting on disk
 * "File missing". Adding a format here now adds it to all of them.
 *
 * **This module imports nothing, on purpose.** The renderer bundles it — the dialog's hint is the
 * app's first *value* import from `src/shared` — and `tsconfig.web.json` has no node types, so
 * `contentTypeFor` and its `node:path` stay behind in main's `mimeTypes.ts`.
 */

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  // Opus is served in an Ogg container — `audio/opus` is not a registered type.
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  // Raw ADTS, which Chromium decodes — but only if it is not handed the octet-stream fallback.
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  // Where a yt-dlp `bestaudio` fallback lands, so the library already holds these.
  '.webm': 'audio/webm'
}

/** The same extensions undotted, which is the shape a file-picker filter wants. */
export const AUDIO_EXTENSIONS: readonly string[] = Object.keys(MIME_TYPES).map((ext) =>
  ext.slice(1)
)

/** The formats whose written name is not simply the extension shouted. */
const LABEL_OVERRIDES: Readonly<Record<string, string>> = { opus: 'Opus', webm: 'WebM' }

/** How the formats are named to the user — map order, so the hint and the picker agree. */
export const AUDIO_FORMAT_LABELS: readonly string[] = AUDIO_EXTENSIONS.map(
  (ext) => LABEL_OVERRIDES[ext] ?? ext.toUpperCase()
)
