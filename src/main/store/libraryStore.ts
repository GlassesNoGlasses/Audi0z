import { randomUUID } from 'node:crypto'
import type { LibraryFile, Song } from '../../shared/types'
import { libraryJsonPath } from '../paths'
import { NotFoundError } from './errors'
import { loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreateLibraryStore } from './storeTypes'

/**
 * `library.json` behind the `LibraryStore` interface.
 *
 * Write-through in-memory copy: the `media://` handler calls `getSong` on every Range request, so
 * reads must not hit the disk. The file is loaded lazily on the first call — constructing a store
 * is free, which keeps startup off the critical path.
 *
 * Everything handed out is a copy; the cached array is the single source of truth.
 */

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isSong(value: unknown): value is Song {
  if (typeof value !== 'object' || value === null) return false
  const song = value as Partial<Song>
  return (
    typeof song.id === 'string' &&
    typeof song.fileName === 'string' &&
    typeof song.title === 'string' &&
    isStringArray(song.tags) &&
    typeof song.addedAt === 'string' &&
    typeof song.compressed === 'boolean' &&
    (song.sourceUrl === undefined || typeof song.sourceUrl === 'string')
  )
}

function isLibraryFile(value: unknown): value is LibraryFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<LibraryFile>
  return file.version === 1 && Array.isArray(file.songs) && file.songs.every(isSong)
}

const emptyLibrary = (): LibraryFile => ({ version: 1, songs: [] })

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function cloneSong(song: Song): Song {
  return { ...song, tags: [...song.tags] }
}

export const createLibraryStore: CreateLibraryStore = (dir) => {
  const filePath = libraryJsonPath(dir)
  // Loaded once and kept for the life of the process: this cache never re-reads the file, so every
  // reader and every mutator of a given library directory must share ONE store instance. A second
  // instance over the same dir will not see the first one's writes.
  const load = loadOnce(async () => {
    const file = await readJsonFile(filePath, isLibraryFile, emptyLibrary)
    return file.songs
  })

  async function persist(current: Song[]): Promise<void> {
    const file: LibraryFile = { version: 1, songs: current }
    await writeJsonFile(filePath, file)
  }

  return {
    async list() {
      return (await load()).map(cloneSong)
    },

    async getSong(id) {
      const found = (await load()).find((song) => song.id === id)
      return found ? cloneSong(found) : undefined
    },

    /**
     * The importer builds the whole record, but id and `addedAt` are the store's business: it
     * backfills either one that arrives empty or missing so no caller can invent a duplicate id.
     */
    async add(song) {
      const current = await load()
      const stored: Song = {
        ...song,
        id: isFilledString(song.id) ? song.id : randomUUID(),
        addedAt: isFilledString(song.addedAt) ? song.addedAt : new Date().toISOString(),
        tags: isStringArray(song.tags) ? [...song.tags] : []
      }
      current.push(stored)
      await persist(current)
      return cloneSong(stored)
    },

    async update(id, patch) {
      const current = await load()
      const index = current.findIndex((song) => song.id === id)
      if (index === -1) throw new NotFoundError(`No song with id "${id}"`)

      const updated: Song = {
        ...current[index],
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {})
      }
      current[index] = updated
      await persist(current)
      return cloneSong(updated)
    },

    /**
     * Metadata only: trashing the audio file and cascading into playlists is the caller's job
     * (see `registerLibraryIpc`), which keeps this store single-purpose. Removing an id that is
     * already gone is a no-op, not an error.
     */
    async remove(id) {
      const current = await load()
      const index = current.findIndex((song) => song.id === id)
      if (index === -1) return
      current.splice(index, 1)
      await persist(current)
    }
  }
}
