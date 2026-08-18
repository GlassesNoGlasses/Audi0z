import path from 'node:path'
import { AUDIO_EXTENSIONS, MIME_TYPES } from '../../shared/audioFormats'

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

export function contentTypeFor(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}

export function isPlayableFile(fileName: string): boolean {
  return contentTypeFor(fileName) !== DEFAULT_CONTENT_TYPE
}

/** Local file filter to remove importing `electron` file filter */
interface AudioFileFilter {
  name: string
  extensions: string[]
}

export const AUDIO_FILE_FILTERS: readonly AudioFileFilter[] = [
  { name: 'Audio', extensions: [...AUDIO_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] }
]
