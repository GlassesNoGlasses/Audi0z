import { randomUUID } from 'node:crypto'
import { access, copyFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Song } from '../../shared/types'
import type { LibraryStore } from '../store/storeTypes'

/**
 * The one place a file becomes a library song — the file picker and URL downloads both funnel
 * through here, so "copy or transcode, then record, and never leave a half-import behind"
 * is written once.
 *
 * `compress: true` is a request, not a promise: the re-encode is staged and measured, and a source
 * the Opus run could not beat is copied in as it stands.
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
  /** Only `size` is ever read — a fake owes nothing else. */
  stat(p: string): Promise<{ size: number }>
  rename(from: string, to: string): Promise<void>
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

export const nodeFs: ImporterFs = { access, copyFile, stat, rename, rm }

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
  // Where a re-encode goes before it has earned the right to be the song. Staged rather than
  // written at `<id>.opus` because a re-encode that is not smaller never gets that name.
  const staged = path.join(deps.audioDir, `${id}.opus.staged`)

  // Both start as the plain-copy answer; only a re-encode that actually shrank moves them.
  let fileName = `${id}${path.extname(req.sourcePath).toLowerCase()}`
  let target = path.join(deps.audioDir, fileName)
  let compressed = false

  try {
    if (req.compress) {
      await deps.transcode({ src: req.sourcePath, dst: staged })
      // Opus is not guaranteed to win: an already-lean lossy source can re-encode bigger, and the
      // user asked for a smaller file, not for Opus.
      const [source, opus] = await Promise.all([fs.stat(req.sourcePath), fs.stat(staged)])
      compressed = opus.size < source.size
    }

    if (compressed) {
      fileName = `${id}.opus`
      target = path.join(deps.audioDir, fileName)
      await fs.rename(staged, target)
    } else {
      // Best effort, like the source delete below: a staged file that refuses to go is a stray few
      // megabytes beside a song that imported fine, not a reason to fail the import.
      if (req.compress) await fs.rm(staged, { force: true }).catch(() => undefined)
      await fs.copyFile(req.sourcePath, target)
    }

    const song: Song = {
      id,
      fileName,
      title: req.title,
      tags: [...req.tags],
      addedAt: new Date().toISOString(),
      compressed
    }
    if (req.sourceUrl !== undefined) song.sourceUrl = req.sourceUrl

    const added = await deps.libraryStore.add(song)

    // Best effort: the song is already in the library, so a source that refuses to go is a stray
    // temp file, not a failed import.
    if (req.deleteSource) await fs.rm(req.sourcePath, { force: true }).catch(() => undefined)

    return added
  } catch (error) {
    // Anything at all went wrong: the audio directory must look untouched. Both names, because
    // which of them exists depends on how far down the compress path the failure happened.
    await Promise.all([
      fs.rm(staged, { force: true }).catch(() => undefined),
      fs.rm(target, { force: true }).catch(() => undefined)
    ])
    throw error
  }
}
