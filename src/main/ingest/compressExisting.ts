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
 * The ordering is what makes it safe to interrupt: transcode, then record, then tidy up. Until
 * `replaceFile` succeeds, `library.json` still points at a file that is still there, so a failure
 * anywhere before it leaves a playable library and nothing to clean up by hand.
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

export async function compressExisting(id: string, deps: CompressDeps): Promise<Song> {
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

  // `src === dst` when the song is an uncompressed `.opus` already named after its id. That is
  // safe rather than special-cased: `transcode` writes `<dst>.part` and renames over the target,
  // so the replace is atomic — and the delete below is skipped, or it would remove the new file.
  await deps.transcode({ src, dst })

  const updated = await deps.libraryStore.replaceFile(song.id, fileName, true)

  // Best effort: the library already points at the new file, so an old one that refuses to go is
  // a stray few megabytes, not a failed compression.
  if (src !== dst) await fs.rm(src, { force: true }).catch(() => undefined)

  return updated
}
