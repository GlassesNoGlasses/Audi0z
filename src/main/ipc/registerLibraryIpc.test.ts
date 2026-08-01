import path from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { IPC } from '../../shared/ipc'
import type { AddSongRequest, Playlist, Settings, Song, SongDto } from '../../shared/types'
import { createLibraryStore } from '../store/libraryStore'
import { createPlaylistStore } from '../store/playlistStore'
import { createSettingsStore } from '../store/settingsStore'
import type { LibraryStore, PlaylistStore, SettingsStore } from '../store/storeTypes'
import { registerLibraryIpc } from './registerLibraryIpc'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Harness {
  channels: string[]
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  libraryStore: LibraryStore
  playlistStore: PlaylistStore
  settingsStore: SettingsStore
  audioDir: string
  importSong: ReturnType<typeof vi.fn>
  trashItem: ReturnType<typeof vi.fn>
  fileExists: ReturnType<typeof vi.fn>
  revealInFolder: ReturnType<typeof vi.fn>
}

function draftSong(overrides: Partial<Song> = {}): Song {
  return {
    id: '',
    fileName: 'song.wav',
    title: 'Song',
    tags: ['a'],
    addedAt: '',
    compressed: false,
    ...overrides
  }
}

let lib: TmpLibrary

function setup(): Harness {
  const handlers = new Map<string, Listener>()
  const ipc: Pick<IpcMain, 'handle'> = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    }
  }

  const libraryStore = createLibraryStore(lib.root)
  const playlistStore = createPlaylistStore(lib.root)
  const settingsStore = createSettingsStore(lib.root)
  const importSong = vi.fn(async (req: AddSongRequest) =>
    libraryStore.add(
      draftSong({ fileName: path.basename(req.sourcePath), title: req.title, tags: req.tags })
    )
  )
  const trashItem = vi.fn(async (_absPath: string) => {})
  const fileExists = vi.fn(async (_absPath: string) => true)
  const revealInFolder = vi.fn((_absPath: string) => {})

  registerLibraryIpc(ipc, {
    libraryStore,
    playlistStore,
    settingsStore,
    audioDir: lib.audio,
    importSong,
    trashItem,
    fileExists,
    revealInFolder
  })

  return {
    channels: [...handlers.keys()],
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const listener = handlers.get(channel)
      if (!listener) throw new Error(`no handler registered for ${channel}`)
      return (await listener({} as IpcMainInvokeEvent, ...args)) as T
    },
    libraryStore,
    playlistStore,
    settingsStore,
    audioDir: lib.audio,
    importSong,
    trashItem,
    fileExists,
    revealInFolder
  }
}

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

describe('channel registration', () => {
  it('registers every library, playlist and settings channel', () => {
    const { channels } = setup()

    const expected = [
      ...Object.values(IPC.library),
      ...Object.values(IPC.playlists),
      ...Object.values(IPC.settings)
    ]
    expect([...channels].sort()).toEqual([...expected].sort())
  })

  it('leaves the ingest channels to their own module', () => {
    const { channels } = setup()

    for (const channel of [
      ...Object.values(IPC.files),
      ...Object.values(IPC.download),
      ...Object.values(IPC.ytdlp)
    ]) {
      expect(channels).not.toContain(channel)
    }
  })
})

describe(IPC.library.list, () => {
  it('maps songs to SongDtos with a media:// url', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong({ title: 'Nightdrive' }))

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto).toEqual({ ...added, exists: true, url: `media://audio/${added.id}` })
    expect(harness.fileExists).toHaveBeenCalledWith(path.join(lib.audio, added.fileName))
  })

  it('reports exists:false when the backing file is gone', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong())
    harness.fileExists.mockResolvedValue(false)

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.exists).toBe(false)
  })

  it('reports exists:false for a fileName pointing outside the audio directory', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong({ fileName: '../../etc/passwd' }))

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.exists).toBe(false)
    expect(harness.fileExists).not.toHaveBeenCalled()
  })
})

describe(IPC.library.add, () => {
  it('delegates to the injected importer and returns a dto', async () => {
    const harness = setup()
    const request: AddSongRequest = {
      sourcePath: path.join(path.sep, 'downloads', 'track.wav'),
      title: 'Track',
      tags: ['new'],
      compress: false
    }

    const dto = await harness.invoke<SongDto>(IPC.library.add, request)

    expect(harness.importSong).toHaveBeenCalledWith(request)
    expect(dto.url).toBe(`media://audio/${dto.id}`)
    expect(await harness.libraryStore.list()).toHaveLength(1)
  })

  it.each([
    [undefined],
    [{ title: 'x', tags: [], compress: false }],
    [{ sourcePath: '', title: 'x', tags: [], compress: false }],
    [{ sourcePath: '/a.wav', title: '', tags: [], compress: false }],
    [{ sourcePath: '/a.wav', title: 'x', tags: 'nope', compress: false }],
    [{ sourcePath: '/a.wav', title: 'x', tags: [1], compress: false }],
    [{ sourcePath: '/a.wav', title: 'x', tags: [], compress: 'yes' }]
  ])('rejects a malformed request (%#)', async (request) => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.add, request)).rejects.toThrow()
    expect(harness.importSong).not.toHaveBeenCalled()
  })
})

describe(IPC.library.update, () => {
  it('patches the song and returns the dto', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())

    const dto = await harness.invoke<SongDto>(IPC.library.update, added.id, {
      title: 'Renamed',
      tags: ['x']
    })

    expect(dto).toEqual({ ...added, title: 'Renamed', tags: ['x'], exists: true, url: dto.url })
  })

  it('propagates NotFound for an unknown id', async () => {
    const harness = setup()

    await expect(
      harness.invoke(IPC.library.update, 'missing', { title: 'x' })
    ).rejects.toMatchObject({ name: 'NotFound' })
  })

  it.each([
    ['', { title: 'x' }],
    [42, { title: 'x' }],
    ['id', undefined],
    ['id', { title: 7 }],
    ['id', { tags: 'x' }],
    ['id', { tags: [1] }]
  ])('rejects a malformed payload (%s, %s)', async (id, patch) => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.update, id, patch)).rejects.toThrow()
  })
})

describe(IPC.library.remove, () => {
  it('trashes the file before touching the stores, then cascades', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())
    const playlist = await harness.playlistStore.create('P')
    await harness.playlistStore.addSong(playlist.id, added.id)
    const cascade = vi.spyOn(harness.playlistStore, 'cascadeRemoveSong')

    let stillPresentWhileTrashing: Song | undefined
    harness.trashItem.mockImplementation(async () => {
      stillPresentWhileTrashing = await harness.libraryStore.getSong(added.id)
      expect(cascade).not.toHaveBeenCalled()
    })

    await harness.invoke(IPC.library.remove, added.id)

    expect(harness.trashItem).toHaveBeenCalledWith(path.join(lib.audio, added.fileName))
    expect(stillPresentWhileTrashing).toBeDefined()
    expect(await harness.libraryStore.list()).toEqual([])
    expect(cascade).toHaveBeenCalledWith(added.id)
    expect((await harness.playlistStore.list())[0]?.songIds).toEqual([])
  })

  it('changes nothing when trashing fails and propagates the error', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())
    const playlist = await harness.playlistStore.create('P')
    await harness.playlistStore.addSong(playlist.id, added.id)
    const cascade = vi.spyOn(harness.playlistStore, 'cascadeRemoveSong')
    harness.trashItem.mockRejectedValue(new Error('trash is full'))

    await expect(harness.invoke(IPC.library.remove, added.id)).rejects.toThrow('trash is full')

    expect(await harness.libraryStore.list()).toEqual([added])
    expect(cascade).not.toHaveBeenCalled()
    expect((await harness.playlistStore.list())[0]?.songIds).toEqual([added.id])
  })

  it('throws NotFound without trashing anything for an unknown id', async () => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.remove, 'missing')).rejects.toMatchObject({
      name: 'NotFound'
    })
    expect(harness.trashItem).not.toHaveBeenCalled()
  })

  it('refuses to trash a path outside the audio directory', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong({ fileName: '../../etc/passwd' }))

    await expect(harness.invoke(IPC.library.remove, added.id)).rejects.toThrow()
    expect(harness.trashItem).not.toHaveBeenCalled()
    expect(await harness.libraryStore.list()).toHaveLength(1)
  })

  it.each([[''], [undefined], [42]])('rejects a malformed id (%s)', async (id) => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.remove, id)).rejects.toThrow()
    expect(harness.trashItem).not.toHaveBeenCalled()
  })
})

describe(IPC.library.revealInFolder, () => {
  it('reveals the absolute path of the song', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())

    await harness.invoke(IPC.library.revealInFolder, added.id)

    expect(harness.revealInFolder).toHaveBeenCalledWith(path.join(lib.audio, added.fileName))
  })

  it('throws NotFound for an unknown id', async () => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.revealInFolder, 'missing')).rejects.toMatchObject({
      name: 'NotFound'
    })
    expect(harness.revealInFolder).not.toHaveBeenCalled()
  })
})

describe('playlist channels', () => {
  it('creates, renames, adds, removes and sets playback options', async () => {
    const harness = setup()

    const created = await harness.invoke<Playlist>(IPC.playlists.create, 'Mix')
    expect(created.name).toBe('Mix')

    const renamed = await harness.invoke<Playlist>(IPC.playlists.rename, created.id, 'Mix 2')
    expect(renamed.name).toBe('Mix 2')

    const withSong = await harness.invoke<Playlist>(IPC.playlists.addSong, created.id, 'song-1')
    expect(withSong.songIds).toEqual(['song-1'])

    const withoutSong = await harness.invoke<Playlist>(
      IPC.playlists.removeSong,
      created.id,
      'song-1'
    )
    expect(withoutSong.songIds).toEqual([])

    const shuffled = await harness.invoke<Playlist>(IPC.playlists.setPlaybackOptions, created.id, {
      shuffle: true
    })
    expect(shuffled).toMatchObject({ shuffle: true, repeat: false })

    expect(await harness.invoke<Playlist[]>(IPC.playlists.list)).toHaveLength(1)

    await harness.invoke(IPC.playlists.remove, created.id)
    expect(await harness.invoke<Playlist[]>(IPC.playlists.list)).toEqual([])
  })

  it.each([
    [IPC.playlists.create, ['']],
    [IPC.playlists.create, [42]],
    [IPC.playlists.rename, ['id', '']],
    [IPC.playlists.remove, [undefined]],
    [IPC.playlists.addSong, ['id', 42]],
    [IPC.playlists.addSong, ['', 'song']],
    [IPC.playlists.removeSong, ['id', '']],
    [IPC.playlists.setPlaybackOptions, ['id', { shuffle: 'yes' }]],
    [IPC.playlists.setPlaybackOptions, ['id', undefined]],
    [IPC.playlists.setPlaybackOptions, ['id', { repeat: 1 }]]
  ])('rejects malformed %s payloads (%s)', async (channel, args) => {
    const harness = setup()

    await expect(harness.invoke(channel, ...args)).rejects.toThrow()
    expect(await harness.playlistStore.list()).toEqual([])
  })
})

describe('settings channels', () => {
  it('gets and merges settings', async () => {
    const harness = setup()

    expect(await harness.invoke<Settings>(IPC.settings.get)).toMatchObject({ volume: 1 })

    const updated = await harness.invoke<Settings>(IPC.settings.set, { volume: 0.4 })
    expect(updated.volume).toBe(0.4)
    expect(await harness.settingsStore.get()).toMatchObject({ volume: 0.4 })
  })

  it.each([[undefined], [null], ['nope'], [{ volume: 'loud' }], [{ compressByDefault: 1 }]])(
    'rejects a malformed patch (%s)',
    async (patch) => {
      const harness = setup()

      await expect(harness.invoke(IPC.settings.set, patch)).rejects.toThrow()
      expect(await harness.settingsStore.get()).toMatchObject({ volume: 1 })
    }
  )
})
