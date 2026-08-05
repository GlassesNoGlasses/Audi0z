import { randomUUID } from 'node:crypto'
import type { Playlist, PlaylistsFile } from '../../shared/types'
import { playlistsJsonPath } from '../paths'
import { ConflictError, NotFoundError } from './errors'
import { loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreatePlaylistStore } from './storeTypes'

/**
 * `playlists.json` behind the `PlaylistStore` interface.
 *
 * A playlist owns nothing but an ordered list of song ids plus its own shuffle/repeat flags — it
 * never touches `library.json`. The one link back is `cascadeRemoveSong`, which the delete flow
 * calls after a song has actually been trashed.
 */

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

  /** Replaces the entry at `index` with `next`, persists, and hands back a copy. */
  async function replace(current: Playlist[], index: number, next: Playlist): Promise<Playlist> {
    current[index] = next
    await persist(current)
    return clonePlaylist(next)
  }

  return {
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

    /**
     * The stored order is the sidebar's order, so rearranging the sidebar is a write to this array.
     *
     * The whole order arrives at once and is validated before anything moves: a call that names
     * fewer, more, or unknown playlists is refused outright rather than half-applied. The cached
     * array is rearranged in place — `loadOnce` hands the same one out for the process lifetime,
     * the same reason `remove` splices rather than reassigns.
     */
    async reorder(orderedIds) {
      const current = await load()
      if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== current.length) {
        throw new ConflictError('Reorder must name every playlist exactly once.')
      }
      const byId = new Map(current.map((playlist) => [playlist.id, playlist]))
      const next = orderedIds.map((id) => {
        const found = byId.get(id)
        if (found === undefined) throw new NotFoundError(`No playlist with id "${id}"`)
        return found
      })
      current.splice(0, current.length, ...next)
      await persist(current)
      return current.map(clonePlaylist)
    },

    async addSong(playlistId, songId) {
      const { current, index } = await mustFind(playlistId)
      const playlist = current[index]
      // A song can sit in a playlist exactly once; adding it again keeps its original position.
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

    /** Called after a song has been trashed, so no playlist keeps pointing at a dead id. */
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
    }
  }
}
