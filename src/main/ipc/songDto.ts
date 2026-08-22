import { MEDIA_SCHEME } from '../../shared/ipc'
import type { Song, SongDto } from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'

/** Structurally satisfied by both `LibraryIpcDeps` and `IngestIpcDeps`; pass either one in. */
export interface SongDtoDeps {
  audioDir: string // absolute
  /** **Must not reject** — `null` means "could not measure" (missing, unreadable, not a file).*/
  fileSize(absPath: string): Promise<number | null>
}

/**
 * `sizeBytes` is null *exactly* when `exists` is false — one measurement decides both, and a
 * `fileName` resolving outside `audioDir` is never measured.
 * `url` percent-encodes the id, because `mediaProtocol` decodes the path segment it receives.
 */
export async function toSongDto(song: Song, opts: SongDtoDeps): Promise<SongDto> {
  const resolved = resolveAudioPath(opts.audioDir, song.fileName)
  const size = resolved === null ? null : await opts.fileSize(resolved)
  return {
    ...song,
    exists: size !== null,
    url: `${MEDIA_SCHEME}://audio/${encodeURIComponent(song.id)}`,
    sizeBytes: size
  }
}
