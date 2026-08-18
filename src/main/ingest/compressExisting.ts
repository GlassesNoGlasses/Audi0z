import path from 'node:path'
import type { Song } from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'
import { NotFoundError } from '../store/errors'
import type { LibraryStore } from '../store/storeTypes'
import { nodeFs, pathExists, type ImporterFs } from './importer'

export interface CompressDeps {
  audioDir: string
  libraryStore: LibraryStore
  transcode(opts: { src: string; dst: string }): Promise<void>
  fs?: ImporterFs
}

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

  const src = resolveAudioPath(deps.audioDir, song.fileName)
  if (src === null) {
    throw new Error(`Song "${song.id}" has a fileName outside the audio directory`)
  }
  if (!(await pathExists(fs, src))) {
    throw new Error(`source file not found: ${src}`)
  }

  const fileName = `${song.id}.opus`
  const dst = path.join(deps.audioDir, fileName)
  const staged = path.join(deps.audioDir, `${song.id}.opus.staged`)

  await deps.transcode({ src, dst: staged })

  const [srcSize, stagedSize] = await Promise.all([fs.stat(src), fs.stat(staged)])
  if (stagedSize.size >= srcSize.size) { // compression did not make smaller file
    await fs.rm(staged, { force: true }).catch(() => undefined)
    return { song, shrank: false }
  }

  await fs.rename(staged, dst)
  const updated = await deps.libraryStore.replaceFile(song.id, fileName, true)

  if (src !== dst) await fs.rm(src, { force: true }).catch(() => undefined)

  return { song: updated, shrank: true }
}
