import { vi } from 'vitest'
import type { Api } from '../../src/shared/api'
import type {
  AppError,
  DownloadProgress,
  DownloadRequest,
  Playlist,
  Settings,
  SongDto,
  Tag
} from '../../src/shared/types'

/**
 * In-memory stand-in for the preload `Api`.
 *
 * `createMockApi()` returns an object whose key structure is *exactly* `Api` (guarded by
 * `src/shared/api.test.ts`), so it can be dropped straight onto `window.api`. Everything a test
 * needs beyond the contract — seeded state, event emitters — is reached through
 * `mockApiControls(api)` rather than by hanging extra keys off the api object.
 *
 * Every member is a `vi.fn`, so `vi.mocked(api.library.list).mockRejectedValueOnce(...)` works for
 * failure-path tests while the default implementation behaves like a real (tiny) library.
 */

export const DEFAULT_MOCK_SETTINGS: Settings = {
  version: 1,
  compressByDefault: false,
  volume: 1,
  libraryShuffle: false,
  libraryRepeat: false
}

/**
 * A seeded song may leave `sizeBytes` out — almost no test cares what a song weighs, and the ones
 * that do say so explicitly.
 */
export type MockApiSeedSong = Omit<SongDto, 'sizeBytes'> & { sizeBytes?: number | null }

/** What a song weighs when the seed does not say. Roughly a four-minute 128k file. */
export const DEFAULT_MOCK_SIZE_BYTES = 4_000_000

/**
 * What a mock compression leaves behind: the ~25% saving the Settings dialog quotes, so a test can
 * click Compress and see a figure that agrees with the estimate the same UI printed beside it.
 */
const COMPRESSED_SIZE_RATIO = 0.75

/** Cycled rather than random: a tag's colour has to be the same on every run of a test. */
const MOCK_TAG_COLORS = ['#e05c5c', '#e0a35c', '#5ce07a', '#5ca8e0', '#a35ce0']

export interface MockApiSeed {
  songs?: MockApiSeedSong[]
  playlists?: Playlist[]
  tags?: Tag[]
  settings?: Partial<Settings>
}

export interface MockApiState {
  songs: SongDto[]
  playlists: Playlist[]
  tags: Tag[]
  settings: Settings
}

export interface MockApiControls {
  /** Live, mutable state — assert against it or mutate it mid-test. */
  state: MockApiState
  emitDownloadProgress(progress: DownloadProgress): void
  emitLibraryChanged(): void
  emitError(error: AppError): void
}

const CONTROLS = new WeakMap<Api, MockApiControls>()

/** Access the emitters and state of a mock created by `createMockApi()`. */
export function mockApiControls(api: Api): MockApiControls {
  const controls = CONTROLS.get(api)
  if (!controls) {
    throw new Error('mockApiControls(): this object was not created by createMockApi()')
  }
  return controls
}

/**
 * Nothing may leave the mock while still sharing an array with its internal state — a caller that
 * mutates the `tags` of a returned song would otherwise silently rewrite the fake library.
 */
function cloneSong(song: SongDto): SongDto {
  return { ...song, tags: [...song.tags] }
}

/**
 * Seed -> state: the one place a missing `sizeBytes` becomes the default.
 *
 * `exists: false` answers first, because the DTO invariant both main-process producers uphold is
 * that `sizeBytes` is null exactly when `exists` is false: a seed that says the file is gone gets
 * the null whether or not it remembered to say so, since a mock that weighed a missing file would
 * let a test pass against a shape the app never produces. For a song that is there, an explicit
 * size — `0` included — is kept, and only an absent one becomes the default.
 */
function adoptSong(song: MockApiSeedSong): SongDto {
  return {
    ...song,
    tags: [...song.tags],
    sizeBytes:
      song.exists === false
        ? null
        : song.sizeBytes === undefined
          ? DEFAULT_MOCK_SIZE_BYTES
          : song.sizeBytes
  }
}

function clonePlaylist(playlist: Playlist): Playlist {
  return { ...playlist, songIds: [...playlist.songIds] }
}

function cloneTag(tag: Tag): Tag {
  return { ...tag }
}

/**
 * Same rule as `libraryStore.renameTag`: a song that already carries `next` loses `previous` rather
 * than ending up with the same tag twice — but renaming a tag to its own name is a no-op, or the
 * merge branch would delete it instead.
 */
function renameIn(tags: string[], previous: string, next: string): string[] {
  if (previous === next) return tags
  if (!tags.includes(previous)) return tags
  if (tags.includes(next)) return tags.filter((name) => name !== previous)
  return tags.map((name) => (name === previous ? next : name))
}

function extensionOf(sourcePath: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(sourcePath)
  return match ? match[0].toLowerCase() : '.mp3'
}

function makeEmitter<Args extends unknown[]>(): {
  subscribe: (cb: (...args: Args) => void) => () => void
  emit: (...args: Args) => void
} {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    emit: (...args) => {
      for (const cb of [...listeners]) cb(...args)
    }
  }
}

export function createMockApi(seed: MockApiSeed = {}): Api {
  const state: MockApiState = {
    songs: (seed.songs ?? []).map(adoptSong),
    playlists: (seed.playlists ?? []).map(clonePlaylist),
    tags: (seed.tags ?? []).map(cloneTag),
    settings: { ...DEFAULT_MOCK_SETTINGS, ...seed.settings }
  }

  let nextId = 1
  const id = (prefix: string): string => `${prefix}-${nextId++}`

  const progress = makeEmitter<[DownloadProgress]>()
  const libraryChanged = makeEmitter<[]>()
  const errors = makeEmitter<[AppError]>()

  const findSong = (songId: string): SongDto => {
    const song = state.songs.find((s) => s.id === songId)
    if (!song) throw new Error(`mockApi: no song ${songId}`)
    return song
  }

  const findPlaylist = (playlistId: string): Playlist => {
    const playlist = state.playlists.find((p) => p.id === playlistId)
    if (!playlist) throw new Error(`mockApi: no playlist ${playlistId}`)
    return playlist
  }

  /**
   * Mirrors `tagStore`: a trimmed, non-empty, case-insensitively unique name. `exceptId` lets a
   * rename keep its own name while only changing its case.
   */
  const assertTagName = (name: string, exceptId?: string): string => {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('mockApi: a tag name must not be empty')
    const clash = state.tags.find(
      (t) => t.id !== exceptId && t.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (clash) throw new Error(`A tag named "${clash.name}" already exists`)
    return trimmed
  }

  const insertSong = (input: {
    title: string
    tags: string[]
    compress: boolean
    extension: string
    sourceUrl?: string
  }): SongDto => {
    const songId = id('song')
    const song: SongDto = {
      id: songId,
      fileName: `${songId}${input.extension}`,
      title: input.title,
      tags: [...input.tags],
      addedAt: new Date(0).toISOString(),
      compressed: input.compress,
      exists: true,
      url: `media://audio/${songId}`,
      sizeBytes: DEFAULT_MOCK_SIZE_BYTES,
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl })
    }
    state.songs.push(song)
    libraryChanged.emit()
    return cloneSong(song)
  }

  const api: Api = {
    library: {
      list: vi.fn(async () => state.songs.map(cloneSong)),
      add: vi.fn(async (req) =>
        insertSong({
          title: req.title,
          tags: req.tags,
          compress: req.compress,
          extension: req.compress ? '.opus' : extensionOf(req.sourcePath)
        })
      ),
      update: vi.fn(async (songId, patch) => {
        const song = findSong(songId)
        if (patch.title !== undefined) song.title = patch.title
        if (patch.tags !== undefined) song.tags = [...patch.tags]
        if (patch.durationSec !== undefined) song.durationSec = patch.durationSec
        libraryChanged.emit()
        return cloneSong(song)
      }),
      updateDurations: vi.fn(async (entries: Array<{ id: string; durationSec: number }>) => {
        const updated: SongDto[] = []
        for (const { id: songId, durationSec } of entries) {
          // Unlike `update`, an id that is not here is passed over: the real handler does the same,
          // because a song can be deleted between the probe that measured it and the write.
          const song = state.songs.find((entry) => entry.id === songId)
          if (!song) continue
          song.durationSec = durationSec
          updated.push(cloneSong(song))
        }
        if (updated.length > 0) libraryChanged.emit()
        return updated
      }),
      remove: vi.fn(async (songId) => {
        findSong(songId)
        state.songs = state.songs.filter((song) => song.id !== songId)
        for (const playlist of state.playlists) {
          playlist.songIds = playlist.songIds.filter((sid) => sid !== songId)
        }
        libraryChanged.emit()
      }),
      // Same contract as the store: the whole order at once, every song exactly once. No
      // `libraryChanged` here — the real channel answers nothing and emits nothing, so the
      // renderer applies the order it sent.
      reorder: vi.fn(async (orderedIds) => {
        const named = new Set(orderedIds)
        if (named.size !== orderedIds.length || orderedIds.length !== state.songs.length) {
          throw new Error('Reorder must name every song exactly once.')
        }
        // Answers nothing, as the real channel does — the renderer applies the order it sent.
        state.songs = orderedIds.map(findSong)
      }),
      // Always the winning outcome: the kept-the-original path is rarer than the one every test
      // means when it clicks Compress, so a test that wants it says so with `mockResolvedValue`.
      compress: vi.fn(async (songId) => {
        const song = findSong(songId)
        song.compressed = true
        song.fileName = `${song.id}.opus`
        if (song.sizeBytes !== null)
          song.sizeBytes = Math.round(song.sizeBytes * COMPRESSED_SIZE_RATIO)
        libraryChanged.emit()
        return { song: cloneSong(song), shrank: true }
      }),
      // Nothing to do but be observable: `vi.fn` is the recording.
      showFolder: vi.fn(async () => {})
    },
    tags: {
      list: vi.fn(async () => state.tags.map(cloneTag)),
      create: vi.fn(async (name) => {
        const tag: Tag = {
          id: id('tag'),
          name: assertTagName(name),
          color: MOCK_TAG_COLORS[state.tags.length % MOCK_TAG_COLORS.length]
        }
        state.tags.push(tag)
        return cloneTag(tag)
      }),
      rename: vi.fn(async (tagId, name) => {
        const tag = state.tags.find((t) => t.id === tagId)
        if (!tag) throw new Error(`mockApi: no tag ${tagId}`)
        const previous = tag.name
        tag.name = assertTagName(name, tagId)
        // The registry is an index over the strings songs actually carry, so it cascades.
        for (const song of state.songs) {
          song.tags = renameIn(song.tags, previous, tag.name)
        }
        libraryChanged.emit()
        return cloneTag(tag)
      }),
      remove: vi.fn(async (tagId) => {
        const tag = state.tags.find((t) => t.id === tagId)
        if (!tag) return
        state.tags = state.tags.filter((t) => t.id !== tagId)
        for (const song of state.songs) {
          song.tags = song.tags.filter((name) => name !== tag.name)
        }
        libraryChanged.emit()
      })
    },
    playlists: {
      list: vi.fn(async () => state.playlists.map(clonePlaylist)),
      create: vi.fn(async (name) => {
        const playlist: Playlist = {
          id: id('playlist'),
          name,
          songIds: [],
          shuffle: false,
          repeat: false,
          createdAt: new Date(0).toISOString()
        }
        state.playlists.push(playlist)
        return clonePlaylist(playlist)
      }),
      remove: vi.fn(async (playlistId) => {
        findPlaylist(playlistId)
        state.playlists = state.playlists.filter((playlist) => playlist.id !== playlistId)
      }),
      rename: vi.fn(async (playlistId, name) => {
        const playlist = findPlaylist(playlistId)
        playlist.name = name
        return clonePlaylist(playlist)
      }),
      // Same contract as the store: the whole order at once, refused outright if it does not name
      // every playlist exactly once.
      reorder: vi.fn(async (orderedIds) => {
        const named = new Set(orderedIds)
        if (named.size !== orderedIds.length || named.size !== state.playlists.length) {
          throw new Error('Reorder must name every playlist exactly once.')
        }
        state.playlists = orderedIds.map(findPlaylist)
        return state.playlists.map(clonePlaylist)
      }),
      addSong: vi.fn(async (playlistId, songId) => {
        const playlist = findPlaylist(playlistId)
        findSong(songId)
        if (!playlist.songIds.includes(songId)) playlist.songIds.push(songId)
        return clonePlaylist(playlist)
      }),
      removeSong: vi.fn(async (playlistId, songId) => {
        const playlist = findPlaylist(playlistId)
        playlist.songIds = playlist.songIds.filter((sid) => sid !== songId)
        return clonePlaylist(playlist)
      }),
      setPlaybackOptions: vi.fn(async (playlistId, opts) => {
        const playlist = findPlaylist(playlistId)
        if (opts.shuffle !== undefined) playlist.shuffle = opts.shuffle
        if (opts.repeat !== undefined) playlist.repeat = opts.repeat
        return clonePlaylist(playlist)
      }),
      // Same contract as the store, one level down: the playlist's own song order.
      reorderSongs: vi.fn(async (playlistId, songIds) => {
        const playlist = findPlaylist(playlistId)
        const named = new Set(songIds)
        if (named.size !== songIds.length || songIds.length !== playlist.songIds.length) {
          throw new Error('Reorder must name every song exactly once.')
        }
        // Submitted against stored, as the real store validates — the reverse direction lets a
        // duplicated stored id smuggle an unknown one through.
        const stored = new Set(playlist.songIds)
        for (const sid of songIds) {
          if (!stored.has(sid)) throw new Error(`No song with id "${sid}"`)
        }
        playlist.songIds = [...songIds]
        return clonePlaylist(playlist)
      })
    },
    files: {
      pickAudioFiles: vi.fn(async () => [])
    },
    download: {
      probe: vi.fn(async (url) => ({
        title: `Mock title for ${url}`,
        sourceUrl: url
      })),
      start: vi.fn(async (req: DownloadRequest) =>
        insertSong({
          title: req.title,
          tags: req.tags,
          compress: req.compress,
          extension: req.compress ? '.opus' : '.m4a',
          sourceUrl: req.url
        })
      ),
      cancel: vi.fn(async () => {}),
      onProgress: vi.fn((cb) => progress.subscribe(cb))
    },
    settings: {
      get: vi.fn(async () => ({ ...state.settings })),
      set: vi.fn(async (patch) => {
        state.settings = { ...state.settings, ...patch, version: 1 }
        return { ...state.settings }
      })
    },
    events: {
      onLibraryChanged: vi.fn((cb) => libraryChanged.subscribe(cb)),
      onError: vi.fn((cb) => errors.subscribe(cb))
    }
  }

  CONTROLS.set(api, {
    state,
    emitDownloadProgress: (p) => progress.emit(p),
    emitLibraryChanged: () => libraryChanged.emit(),
    emitError: (e) => errors.emit(e)
  })

  return api
}
