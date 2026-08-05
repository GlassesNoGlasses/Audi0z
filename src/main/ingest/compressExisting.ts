import path from 'node:path'
import type { Song } from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'
import { NotFoundError } from '../store/errors'
import type { LibraryStore } from '../store/storeTypes'
import { nodeFs, pathExists, type ImporterFs } from './importer'

/**
 * Compresses a song that is already in the library — the "shrink this one" action, as opposed to
 * the importer's "compress on the way in".
 *
 * The ordering is what makes it safe to interrupt: transcode, then compare, then record, then tidy
 * up. Until `replaceFile` succeeds, `library.json` still points at a file that is still there, so
 * a failure anywhere before it leaves a playable library — at worst a stray `.staged` file, which
 * the next run of this song's compression writes straight over.
 *
 * Opus is not guaranteed to win. A source that is already a lean lossy file can re-encode to
 * something the same size or bigger, so the output is staged, measured against the original, and
 * only then allowed to replace it.
 */

export interface CompressDeps {
  /** `<library>/audio` — this module never resolves the library root itself. */
  audioDir: string
  libraryStore: LibraryStore
  /** `ffmpeg.transcode` with its binary path already bound. */
  transcode(opts: { src: string; dst: string }): Promise<void>
  fs?: ImporterFs
}

/** Thrown for a song that has already been through this. `name` is what the IPC layer surfaces. */
function alreadyCompressed(title: string): Error {
  const error = new Error(`Song "${title}" is already compressed`)
  error.name = 'AlreadyCompressed'
  return error
}

export async function compressExisting(
  id: string,
  deps: CompressDeps
): Promise<{ song: Song; shrank: boolean }> {
  const fs = deps.fs ?? nodeFs

  const song = await deps.libraryStore.getSong(id)
  if (!song) throw new NotFoundError(`No song with id "${id}"`)
  if (song.compressed) throw alreadyCompressed(song.title)

  // `fileName` comes out of a hand-editable `library.json`; `../../…` must never reach ffmpeg.
  const src = resolveAudioPath(deps.audioDir, song.fileName)
  if (src === null) {
    throw new Error(`Song "${song.id}" has a fileName outside the audio directory`)
  }
  if (!(await pathExists(fs, src))) {
    throw new Error(`source file not found: ${src}`)
  }

  const fileName = `${song.id}.opus`
  const dst = path.join(deps.audioDir, fileName)
  // Staged NEXT TO the final name, not at it: for an uncompressed `.opus` already named after its
  // id, src === dst, and transcoding straight onto it would destroy the original before the size
  // comparison could save it.
  const staged = path.join(deps.audioDir, `${song.id}.opus.staged`)

  await deps.transcode({ src, dst: staged })

  const [srcSize, stagedSize] = await Promise.all([fs.stat(src), fs.stat(staged)])
  if (stagedSize.size >= srcSize.size) {
    // The whole point is a smaller file. Nothing is recorded: the row still says uncompressed and
    // the original never moved, so this is a no-op the user gets told about, not a failure.
    await fs.rm(staged, { force: true }).catch(() => undefined)
    return { song, shrank: false }
  }

  await fs.rename(staged, dst)
  const updated = await deps.libraryStore.replaceFile(song.id, fileName, true)

  // Best effort: the library already points at the new file, so an old one that refuses to go is
  // a stray few megabytes, not a failed compression. Skipped when src === dst, or it would remove
  // the file the rename just put there.
  if (src !== dst) await fs.rm(src, { force: true }).catch(() => undefined)

  return { song: updated, shrank: true }
}
