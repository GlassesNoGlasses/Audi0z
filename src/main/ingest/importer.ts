import { randomUUID } from 'node:crypto'
import { access, copyFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Song } from '../../shared/types'
import type { LibraryStore } from '../store/storeTypes'

export interface ImportRequest {
  sourcePath: string
  title: string
  tags: string[]
  compress: boolean
  sourceUrl?: string
  deleteSource?: boolean
}

export interface ImporterFs {
  access(p: string): Promise<void>
  copyFile(src: string, dst: string): Promise<void>
  stat(p: string): Promise<{ size: number }>
  rename(from: string, to: string): Promise<void>
  rm(p: string, opts?: { force?: boolean }): Promise<void>
}

export interface ImportDeps {
  audioDir: string
  libraryStore: LibraryStore
  transcode(opts: { src: string; dst: string }): Promise<void>
  fs?: ImporterFs
}

export const nodeFs: ImporterFs = { access, copyFile, stat, rename, rm }

export async function pathExists(fs: ImporterFs, p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Imports a standard file into a library file. Handles temp file creation/deletion
export async function importFile(req: ImportRequest, deps: ImportDeps): Promise<Song> {
  const fs = deps.fs ?? nodeFs

  // invalid file
  if (!(await pathExists(fs, req.sourcePath))) {
    throw new Error(`source file not found: ${req.sourcePath}`)
  }

  const id = randomUUID()
  const staged = path.join(deps.audioDir, `${id}.opus.staged`) // temp comproess file

  // Both start as the plain-copy answer; only a re-encode that actually shrank moves them.
  let fileName = `${id}${path.extname(req.sourcePath).toLowerCase()}`
  let target = path.join(deps.audioDir, fileName)
  let compressed = false

  try {
    if (req.compress) {
      await deps.transcode({ src: req.sourcePath, dst: staged })
      const [source, opus] = await Promise.all([fs.stat(req.sourcePath), fs.stat(staged)])
      compressed = opus.size < source.size
    }

    if (compressed) {
      fileName = `${id}.opus`
      target = path.join(deps.audioDir, fileName)
      await fs.rename(staged, target)
    } else {
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

    if (req.deleteSource) await fs.rm(req.sourcePath, { force: true }).catch(() => undefined)

    return added
  } catch (error) {
    await Promise.all([
      fs.rm(staged, { force: true }).catch(() => undefined),
      fs.rm(target, { force: true }).catch(() => undefined)
    ])
    throw error
  }
}
