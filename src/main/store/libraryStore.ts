import { randomUUID } from 'node:crypto'
import type { LibraryFile, Song } from '../../shared/types'
import { libraryJsonPath } from '../paths'
import { ConflictError, NotFoundError } from './errors'
import { loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreateLibraryStore } from './storeTypes'

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
    (song.sourceUrl === undefined || typeof song.sourceUrl === 'string') &&
    (song.durationSec === undefined || typeof song.durationSec === 'number')
  )
}

function isLibraryFile(value: unknown): value is LibraryFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<LibraryFile>
  return file.version === 1 && Array.isArray(file.songs) && file.songs.every(isSong)
}

const emptyLibrary = (): LibraryFile => ({ version: 1, songs: [] })

function isNotEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// shallow copy to not modify in-memory loaded library
function cloneSong(song: Song): Song {
  return { ...song, tags: [...song.tags] }
}

// adopt a rewrite of a song object in place; original song returned if failed rewrite
function adopt(current: Song[], rewrite: (song: Song) => Song | null): void {
  for (let index = 0; index < current.length; index++) {
    const rewritten = rewrite(current[index])
    if (rewritten !== null) current[index] = rewritten
  }
}

export const createLibraryStore: CreateLibraryStore = (dir) => {
  const filePath = libraryJsonPath(dir)
  const load = loadOnce(async () => {
    const file = await readJsonFile(filePath, isLibraryFile, emptyLibrary)
    return file.songs
  })

  // writes current songs to library file `library.json`
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

    async add(song) {
      const current = await load()
      const stored: Song = {
        ...song,
        id: isNotEmptyString(song.id) ? song.id : randomUUID(),
        addedAt: isNotEmptyString(song.addedAt) ? song.addedAt : new Date().toISOString(),
        tags: isStringArray(song.tags) ? [...song.tags] : []
      }
      current.push(stored)
      await persist(current)
      return cloneSong(stored)
    },

    async update(id, patch) {
      if (patch.title !== undefined && patch.title.trim() === '') {
        throw new Error(`Invalid updated title given ${patch.title}`)
      }
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

    // update in-memory library songs with their duration
    async updateDurations(entries) {
      const byId = new Map(entries.map((entry) => [entry.id, entry.durationSec]))
      const current = await load()
      const updated: Song[] = []
      for (let index = 0; index < current.length; index++) {
        const durationSec = byId.get(current[index].id)
        if (durationSec === undefined) continue
        const changed: Song = { ...current[index], durationSec }
        current[index] = changed
        updated.push(changed)
      }
      if (updated.length === 0) return []
      await persist(current)
      return updated.map(cloneSong)
    },

    async renameTag(oldName, newName) {
      if (oldName === newName) return

      const rewrite = (song: Song): Song | null => {
        if (!song.tags.includes(oldName)) return null
        const tags = song.tags.includes(newName)
          ? song.tags.filter((tag) => tag !== oldName)
          : song.tags.map((tag) => (tag === oldName ? newName : tag))
        return { ...song, tags }
      }

      const current = await load()
      const next = [...current]
      let changed = false
      for (let index = 0; index < next.length; index++) {
        const rewritten = rewrite(next[index])
        if (rewritten === null) continue
        next[index] = rewritten
        changed = true
      }
      if (!changed) return
      await persist(next)
      adopt(current, rewrite)
    },

    async removeTag(name) {
      const rewrite = (song: Song): Song | null =>
        song.tags.includes(name) ? { ...song, tags: song.tags.filter((tag) => tag !== name) } : null

      const current = await load()
      const next = [...current]
      let changed = false
      for (let index = 0; index < next.length; index++) {
        const rewritten = rewrite(next[index])
        if (rewritten === null) continue
        next[index] = rewritten
        changed = true
      }
      if (!changed) return
      await persist(next)
      adopt(current, rewrite)
    },

    async replaceFile(id, fileName, compressed) {
      const current = await load()
      const index = current.findIndex((song) => song.id === id)
      if (index === -1) throw new NotFoundError(`No song with id "${id}"`)

      const updated: Song = { ...current[index], fileName, compressed }
      current[index] = updated
      await persist(current)
      return cloneSong(updated)
    },

    // the library's stored order IS the Custom Order the renderer shows, so rearranging it is a
    // write like any other; same contract as playlistStore.reorder — every song exactly once
    async reorder(orderedIds) {
      const current = await load()
      if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== current.length) {
        throw new ConflictError('Reorder must name every song exactly once.')
      }
      const byId = new Map(current.map((song) => [song.id, song]))
      const next = orderedIds.map((id) => {
        const found = byId.get(id)
        if (found === undefined) throw new NotFoundError(`No song with id "${id}"`)
        return found
      })
      // Disk first, cache after: a failed write must leave the served order untouched, or the
      // next unrelated persist would commit an order the caller was told did not save.
      await persist(next)
      current.splice(0, current.length, ...next)
      return next.map(cloneSong)
    },

    // removes in-memory metadata only; IPC will handle the actual file removal
    async remove(id) {
      const current = await load()
      const index = current.findIndex((song) => song.id === id)
      if (index === -1) return
      current.splice(index, 1)
      await persist(current)
    }
  }
}
