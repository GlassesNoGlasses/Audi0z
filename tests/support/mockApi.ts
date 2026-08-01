import { vi } from 'vitest'
import type { Api } from '../../src/shared/api'
import type {
  AppError,
  DownloadProgress,
  DownloadRequest,
  Playlist,
  Settings,
  SongDto
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

export interface MockApiSeed {
  songs?: SongDto[]
  playlists?: Playlist[]
  settings?: Partial<Settings>
}

export interface MockApiState {
  songs: SongDto[]
  playlists: Playlist[]
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

function clonePlaylist(playlist: Playlist): Playlist {
  return { ...playlist, songIds: [...playlist.songIds] }
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
    songs: (seed.songs ?? []).map(cloneSong),
    playlists: (seed.playlists ?? []).map(clonePlaylist),
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
        libraryChanged.emit()
        return cloneSong(song)
      }),
      remove: vi.fn(async (songId) => {
        findSong(songId)
        state.songs = state.songs.filter((song) => song.id !== songId)
        for (const playlist of state.playlists) {
          playlist.songIds = playlist.songIds.filter((sid) => sid !== songId)
        }
        libraryChanged.emit()
      }),
      revealInFolder: vi.fn(async (songId) => {
        findSong(songId)
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
      })
    },
    files: {
      pickAudioFiles: vi.fn(async () => []),
      getPathForFile: vi.fn((file: File) => `/mock/dropped/${file.name}`)
    },
    download: {
      probe: vi.fn(async (url) => ({
        title: `Mock title for ${url}`,
        durationSec: 123,
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
    ytdlp: {
      update: vi.fn(async () => ({ version: '0.0.0-mock' }))
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
