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

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function cloneSong(song: Song): Song {
  return { ...song, tags: [...song.tags] }
}

/**
 * Writes a finished tag cascade back into the cached array, once the disk has taken it.
 *
 * Two rules meet here. **Disk first:** a write that rejects (ENOSPC, EIO) in a process that carries
 * on must not leave the cache holding contents the file does not have, or the next unrelated write
 * — which stringifies the cache as it finds it — would silently commit half a cascade nobody asked
 * for.
 *
 * **And in place, song by song,** rather than swapping the array for the snapshot the cascade set
 * out with: `persist` is an await, nothing serialises this store's methods against each other, and
 * `current` IS the array every read is served from. An import or the startup duration backfill can
 * land in it while the write is still in the air, and overwriting the array would erase them — from
 * the cache, and then from disk on the very next write. Re-running the same rewrite over whatever
 * `current` holds touches only the songs that match as the cache stands now — including one that
 * arrived mid-write already carrying the tag — and leaves the rest exactly as they arrived.
 */
function adopt(current: Song[], rewrite: (song: Song) => Song | null): void {
  for (let index = 0; index < current.length; index++) {
    const rewritten = rewrite(current[index])
    if (rewritten !== null) current[index] = rewritten
  }
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
     * `id` and `addedAt` are backfilled only when they arrive empty or missing — a convenience for
     * a caller that has no reason to care what they are.
     *
     * A caller that *does* supply an id keeps it verbatim, and that is required rather than merely
     * tolerated: the importer mints the uuid itself and names the audio file after it
     * (`<id><ext>`), so an id regenerated here would no longer match the file on disk, and
     * `media://audio/<id>` would resolve to a song whose `fileName` points at nothing. Uniqueness
     * is therefore the caller's to guarantee, not this store's — the importer gets it from
     * `randomUUID`, and nothing else in the app adds rows.
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
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.durationSec !== undefined ? { durationSec: patch.durationSec } : {})
      }
      current[index] = updated
      await persist(current)
      return cloneSong(updated)
    },

    /**
     * The duration backfill's one write: every measurement in a single persist, the way `renameTag`
     * does — a per-song persist would rewrite `library.json` once per probed song. Unknown ids are
     * skipped, not refused: a song can be deleted between the probe and the flush.
     */
    async updateDurations(entries) {
      const byId = new Map(entries.map((entry) => [entry.id, entry.durationSec]))
      const current = await load()
      const updated: Song[] = []
      // In place: `current` IS the cache every read is served from, so a rebuilt array would reach
      // the disk while `list` kept answering with the old durations. (The tag passes below go
      // further and only `adopt` once the write has landed — a stricter shape this one does not yet
      // share; see the backlog line covering the rest of the mutators.)
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

    /**
     * Renames one tag across the whole library.
     *
     * Exact string match: the tag registry is what decides two names are "the same", and it already
     * refused to let a second tag differ only by case — so a song carrying `Slowed` alongside
     * `slowed` is hand-edited data this pass has no business reinterpreting.
     *
     * One write for the whole pass, and none at all when nothing matched: this runs behind a single
     * `tags:rename` invoke, and a per-song persist would rewrite `library.json` once per song.
     */
    async renameTag(oldName, newName) {
      // Renaming a tag to the name it already has is something the UI can ask for (the rename
      // field's confirm button does not care that nothing changed), and it must mean nothing.
      // Without this the merge branch below reads "the song already carries the new name" as
      // "drop the old one" — and deletes the tag from every song that had it.
      if (oldName === newName) return

      // The whole pass, as one function of one song — `null` for a song that does not carry the
      // tag and must not be touched. Written once and used twice, to build the document and then to
      // adopt it, so the two passes cannot drift apart.
      const rewrite = (song: Song): Song | null => {
        if (!song.tags.includes(oldName)) return null
        // A song that already carries the new name merges the two rather than listing it twice.
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

    /**
     * Drops one tag from every song. Same single-write, disk-first and in-place-adoption rules as
     * `renameTag`.
     */
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

    /**
     * Repoints a song at a different file. Written as its own method rather than folded into
     * `update` because `fileName` is deliberately not patchable from the renderer — the only thing
     * allowed to move a song's audio is the code that just wrote the new file (`compressExisting`).
     */
    async replaceFile(id, fileName, compressed) {
      const current = await load()
      const index = current.findIndex((song) => song.id === id)
      if (index === -1) throw new NotFoundError(`No song with id "${id}"`)

      const updated: Song = { ...current[index], fileName, compressed }
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
