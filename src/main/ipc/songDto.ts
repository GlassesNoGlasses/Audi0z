import { MEDIA_SCHEME } from '../../shared/ipc'
import type { Song, SongDto } from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'

/** Structurally satisfied by both `LibraryIpcDeps` and `IngestIpcDeps`; pass either one straight in. */
export interface SongDtoDeps {
  audioDir: string // absolute
  /** **Must not reject** — `null` means "could not measure" (missing, unreadable, not a file).*/
  fileSize(absPath: string): Promise<number | null>
}

/**
 * The one `Song` -> `SongDto` projection every main-process producer hands the renderer.
 *
 * Invariant: `sizeBytes` is null *exactly* when `exists` is false — a single measurement decides
 * both, so the renderer may read `song.exists ? format(song.sizeBytes) : '—'`. A `fileName` that
 * resolves outside `audioDir` is never measured and counts as missing; a 0-byte file exists.
 *
 * `url` is always `media://audio/<percent-encoded id>`: `mediaProtocol` decodes the path segment it
 * receives, so the id has to be encoded here or the two disagree.
 *
 * Reads nothing but the song it is given — a caller that can race a compression swap must settle
 * that and re-read the record before projecting.
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
