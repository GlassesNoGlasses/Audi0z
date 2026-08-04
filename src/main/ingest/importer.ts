import { randomUUID } from 'node:crypto'
import { access, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Song } from '../../shared/types'
import type { LibraryStore } from '../store/storeTypes'

/**
 * The one place a file becomes a library song — file picker, drag-and-drop and URL download all
 * funnel through here, so "copy or transcode, then record, and never leave a half-import behind"
 * is written once.
 */

export interface ImportRequest {
  /** Absolute path of the file to take in. */
  sourcePath: string
  title: string
  tags: string[]
  compress: boolean
  /** Set for downloads, so the song remembers where it came from. */
  sourceUrl?: string
  /** True when the source is a throwaway (a download temp file), not the user's own file. */
  deleteSource?: boolean
}

/** The slice of `node:fs/promises` the importer needs, so tests can hand it a fake. */
export interface ImporterFs {
  access(p: string): Promise<void>
  copyFile(src: string, dst: string): Promise<void>
  rm(p: string, opts?: { force?: boolean }): Promise<void>
}

export interface ImportDeps {
  /** `<library>/audio` — the importer never resolves paths itself. */
  audioDir: string
  libraryStore: LibraryStore
  /** `ffmpeg.transcode` with its binary path already bound. */
  transcode(opts: { src: string; dst: string }): Promise<void>
  fs?: ImporterFs
}

export const nodeFs: ImporterFs = { access, copyFile, rm }

/** Shared with `compressExisting`, which takes the same fs seam and asks the same question. */
export async function pathExists(fs: ImporterFs, p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function importFile(req: ImportRequest, deps: ImportDeps): Promise<Song> {
  const fs = deps.fs ?? nodeFs

  // Checked first, and before anything is written or recorded: a missing source is the one failure
  // that must cost nothing.
  if (!(await pathExists(fs, req.sourcePath))) {
    throw new Error(`source file not found: ${req.sourcePath}`)
  }

  const id = randomUUID()
  const extension = req.compress ? '.opus' : path.extname(req.sourcePath).toLowerCase()
  const fileName = `${id}${extension}`
  const target = path.join(deps.audioDir, fileName)

  try {
    if (req.compress) {
      await deps.transcode({ src: req.sourcePath, dst: target })
    } else {
      await fs.copyFile(req.sourcePath, target)
    }

    const song: Song = {
      id,
      fileName,
      title: req.title,
      tags: [...req.tags],
      addedAt: new Date().toISOString(),
      compressed: req.compress
    }
    if (req.sourceUrl !== undefined) song.sourceUrl = req.sourceUrl

    const added = await deps.libraryStore.add(song)

    // Best effort: the song is already in the library, so a source that refuses to go is a stray
    // temp file, not a failed import.
    if (req.deleteSource) await fs.rm(req.sourcePath, { force: true }).catch(() => undefined)

    return added
  } catch (error) {
    // Anything at all went wrong: the audio directory must look untouched.
    await fs.rm(target, { force: true }).catch(() => undefined)
    throw error
  }
}
