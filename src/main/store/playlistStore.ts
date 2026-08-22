import { randomUUID } from 'node:crypto'
import type { Playlist, PlaylistsFile } from '../../shared/types'
import { playlistsJsonPath } from '../paths'
import { ConflictError, NotFoundError } from './errors'
import { createMutatorLock, loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreatePlaylistStore, PlaylistStore } from './storeTypes'

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isPlaylist(value: unknown): value is Playlist {
  if (typeof value !== 'object' || value === null) return false
  const playlist = value as Partial<Playlist>
  return (
    typeof playlist.id === 'string' &&
    typeof playlist.name === 'string' &&
    isStringArray(playlist.songIds) &&
    typeof playlist.shuffle === 'boolean' &&
    typeof playlist.repeat === 'boolean' &&
    typeof playlist.createdAt === 'string'
  )
}

function isPlaylistsFile(value: unknown): value is PlaylistsFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<PlaylistsFile>
  return file.version === 1 && Array.isArray(file.playlists) && file.playlists.every(isPlaylist)
}

const emptyPlaylists = (): PlaylistsFile => ({ version: 1, playlists: [] })

function clonePlaylist(playlist: Playlist): Playlist {
  return { ...playlist, songIds: [...playlist.songIds] }
}

export const createPlaylistStore: CreatePlaylistStore = (dir) => {
  const filePath = playlistsJsonPath(dir)
  const load = loadOnce(async () => {
    const file = await readJsonFile(filePath, isPlaylistsFile, emptyPlaylists)
    return file.playlists
  })

  async function persist(current: Playlist[]): Promise<void> {
    const file: PlaylistsFile = { version: 1, playlists: current }
    await writeJsonFile(filePath, file)
  }

  async function mustFind(id: string): Promise<{ current: Playlist[]; index: number }> {
    const current = await load()
    const index = current.findIndex((playlist) => playlist.id === id)
    if (index === -1) throw new NotFoundError(`No playlist with id "${id}"`)
    return { current, index }
  }

  /**
   * Replaces the entry at `index` with `next`, persists, and hands back a copy. Disk first via a
   * draft, cache only after: a failed write must leave the served playlist untouched.
   */
  async function replace(current: Playlist[], index: number, next: Playlist): Promise<Playlist> {
    const draft = [...current]
    draft[index] = next
    await persist(draft)
    current[index] = next
    return clonePlaylist(next)
  }

  const store: PlaylistStore = {
    async list() {
      return (await load()).map(clonePlaylist)
    },

    async create(name) {
      const current = await load()
      const playlist: Playlist = {
        id: randomUUID(),
        name,
        songIds: [],
        shuffle: false,
        repeat: false,
        createdAt: new Date().toISOString()
      }
      current.push(playlist)
      await persist(current)
      return clonePlaylist(playlist)
    },

    async rename(id, name) {
      const { current, index } = await mustFind(id)
      return replace(current, index, { ...current[index], name })
    },

    /** Playlist metadata only — the songs it referenced stay in the library. */
    async remove(id) {
      const current = await load()
      const index = current.findIndex((playlist) => playlist.id === id)
      if (index === -1) return
      current.splice(index, 1)
      await persist(current)
    },

    async reorder(orderedIds) {
      const current = await load()
      // Both halves are load-bearing: a duplicated id can cover every name while the raw list is
      // still the wrong length, and applying it would write one playlist twice.
      if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== current.length) {
        throw new ConflictError('Reorder must name every playlist exactly once.')
      }
      const byId = new Map(current.map((playlist) => [playlist.id, playlist]))
      const next = orderedIds.map((id) => {
        const found = byId.get(id)
        if (found === undefined) throw new NotFoundError(`No playlist with id "${id}"`)
        return found
      })
      // Disk first, cache after, as `replace` above: a failed write must not stick in memory.
      await persist(next)
      current.splice(0, current.length, ...next)
      return next.map(clonePlaylist)
    },

    async addSong(playlistId, songId) {
      const { current, index } = await mustFind(playlistId)
      const playlist = current[index]
      if (playlist.songIds.includes(songId)) return clonePlaylist(playlist)
      return replace(current, index, { ...playlist, songIds: [...playlist.songIds, songId] })
    },

    async removeSong(playlistId, songId) {
      const { current, index } = await mustFind(playlistId)
      const playlist = current[index]
      if (!playlist.songIds.includes(songId)) return clonePlaylist(playlist)
      return replace(current, index, {
        ...playlist,
        songIds: playlist.songIds.filter((id) => id !== songId)
      })
    },

    async setPlaybackOptions(id, opts) {
      const { current, index } = await mustFind(id)
      return replace(current, index, {
        ...current[index],
        ...(opts.shuffle !== undefined ? { shuffle: opts.shuffle } : {}),
        ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {})
      })
    },

    async cascadeRemoveSong(songId) {
      const current = await load()
      let changed = false
      for (let index = 0; index < current.length; index++) {
        const playlist = current[index]
        if (!playlist.songIds.includes(songId)) continue
        current[index] = { ...playlist, songIds: playlist.songIds.filter((id) => id !== songId) }
        changed = true
      }
      if (changed) await persist(current)
    },

    async reorderSongs(playlistId, songIds) {
      const { current, index } = await mustFind(playlistId)
      const playlist = current[index]
      const named = new Set(songIds)
      // Both halves are load-bearing, as in `reorder` above: a duplicated id can cover every name
      // while the raw list is still the wrong length.
      if (named.size !== songIds.length || songIds.length !== playlist.songIds.length) {
        throw new ConflictError('Reorder must name every song exactly once.')
      }
      // Walk the SUBMITTED ids against the stored set — not the reverse: a duplicate in the
      // stored order could otherwise cover every name while an unknown id slips through, and the
      // error must blame the caller's bad id, not a song that is really there.
      const stored = new Set(playlist.songIds)
      for (const id of songIds) {
        if (!stored.has(id)) throw new NotFoundError(`No song with id "${id}"`)
      }
      return replace(current, index, { ...playlist, songIds: [...songIds] })
    }
  }

  // See `createMutatorLock`: mutators serialise so none reads the cache mid-way through another's
  // disk round-trip. `list` stays unlocked.
  const locked = createMutatorLock()
  return {
    ...store,
    create: locked(store.create),
    rename: locked(store.rename),
    remove: locked(store.remove),
    reorder: locked(store.reorder),
    addSong: locked(store.addSong),
    removeSong: locked(store.removeSong),
    setPlaybackOptions: locked(store.setPlaybackOptions),
    cascadeRemoveSong: locked(store.cascadeRemoveSong),
    reorderSongs: locked(store.reorderSongs)
  }
}
