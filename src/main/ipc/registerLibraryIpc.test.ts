import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { IPC } from '../../shared/ipc'
import type {
  AddSongRequest,
  CompressResult,
  Playlist,
  Settings,
  Song,
  SongDto,
  Tag
} from '../../shared/types'
import { libraryJsonPath } from '../paths'
import { createLibraryStore } from '../store/libraryStore'
import { createPlaylistStore } from '../store/playlistStore'
import { createSettingsStore } from '../store/settingsStore'
import { createTagStore } from '../store/tagStore'
import type { LibraryStore, PlaylistStore, SettingsStore, TagStore } from '../store/storeTypes'
import { registerLibraryIpc, type LibraryIpcDeps } from './registerLibraryIpc'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Harness {
  channels: string[]
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  libraryStore: LibraryStore
  playlistStore: PlaylistStore
  settingsStore: SettingsStore
  tagStore: TagStore
  audioDir: string
  importSong: ReturnType<typeof vi.fn>
  trashItem: ReturnType<typeof vi.fn>
  fileExists: ReturnType<typeof vi.fn>
  fileSize: ReturnType<typeof vi.fn>
  compressSong: ReturnType<typeof vi.fn>
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

/**
 * `overrides` replaces individual deps — the compression gate is the only one any test has needed,
 * and every other fixture leaves it out on purpose: `awaitCompression` is optional, so its absence
 * here is what proves the handlers still work in a process with nothing tracking swaps.
 */
function setup(overrides: Partial<LibraryIpcDeps> = {}): Harness {
  const handlers = new Map<string, Listener>()
  const ipc: Pick<IpcMain, 'handle'> = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    }
  }

  const libraryStore = createLibraryStore(lib.root)
  const playlistStore = createPlaylistStore(lib.root)
  const settingsStore = createSettingsStore(lib.root)
  const tagStore = createTagStore(lib.root)
  const importSong = vi.fn(async (req: AddSongRequest) =>
    libraryStore.add(
      draftSong({ fileName: path.basename(req.sourcePath), title: req.title, tags: req.tags })
    )
  )
  const trashItem = vi.fn(async (_absPath: string) => {})
  const fileExists = vi.fn(async (_absPath: string) => true)
  const fileSize = vi.fn(async (_absPath: string): Promise<number | null> => 4096)
  const compressSong = vi.fn(async (id: string) => ({
    song: await libraryStore.replaceFile(id, `${id}.opus`, true),
    shrank: true
  }))
  const revealInFolder = vi.fn((_absPath: string) => {})

  registerLibraryIpc(ipc, {
    libraryStore,
    playlistStore,
    settingsStore,
    tagStore,
    audioDir: lib.audio,
    importSong,
    trashItem,
    fileExists,
    fileSize,
    compressSong,
    revealInFolder,
    ...overrides
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
    tagStore,
    audioDir: lib.audio,
    importSong,
    trashItem,
    fileExists,
    fileSize,
    compressSong,
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
      ...Object.values(IPC.settings),
      ...Object.values(IPC.tags)
    ]
    expect([...channels].sort()).toEqual([...expected].sort())
  })

  it('leaves the ingest channels to their own module', () => {
    const { channels } = setup()

    for (const channel of [...Object.values(IPC.files), ...Object.values(IPC.download)]) {
      expect(channels).not.toContain(channel)
    }
  })
})

describe(IPC.library.list, () => {
  it('maps songs to SongDtos with a media:// url', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong({ title: 'Nightdrive' }))

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto).toEqual({
      ...added,
      exists: true,
      url: `media://audio/${added.id}`,
      sizeBytes: 4096
    })
    expect(harness.fileSize).toHaveBeenCalledWith(path.join(lib.audio, added.fileName))
  })

  /** One stat per song, not a stat *and* an access: `exists` is just "the size came back". */
  it('measures each song exactly once and derives exists from the result', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong())

    await harness.invoke<SongDto[]>(IPC.library.list)

    expect(harness.fileSize).toHaveBeenCalledTimes(1)
    expect(harness.fileExists).not.toHaveBeenCalled()
  })

  it('reports sizeBytes null and exists false when the file cannot be measured', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong())
    harness.fileSize.mockResolvedValue(null)

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.sizeBytes).toBeNull()
    expect(dto.exists).toBe(false)
  })

  /** A 0-byte file is present, however useless — it must not collapse into "missing". */
  it('treats a zero-byte file as existing', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong())
    harness.fileSize.mockResolvedValue(0)

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.sizeBytes).toBe(0)
    expect(dto.exists).toBe(true)
  })

  it('carries a recorded durationSec through to the dto', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())
    await harness.libraryStore.update(added.id, { durationSec: 214 })

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.durationSec).toBe(214)
  })

  /**
   * The id is a uuid in practice, but `library.json` is hand-editable and `mediaProtocol` decodes
   * what it finds in the path — so it has to be encoded on the way out or the two disagree.
   */
  it('percent-encodes the song id into the media url', async () => {
    const harness = setup()
    const id = 'a b#c?d&e'
    await harness.libraryStore.add(draftSong({ id }))

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.url).toBe(`media://audio/${encodeURIComponent(id)}`)
    expect(decodeURIComponent(new URL(dto.url).pathname.slice(1))).toBe(id)
  })

  it('reports exists:false for a fileName pointing outside the audio directory', async () => {
    const harness = setup()
    await harness.libraryStore.add(draftSong({ fileName: '../../etc/passwd' }))

    const [dto] = await harness.invoke<SongDto[]>(IPC.library.list)

    expect(dto.exists).toBe(false)
    expect(dto.sizeBytes).toBeNull()
    expect(harness.fileSize).not.toHaveBeenCalled()
  })

  /**
   * The same courtesy the media protocol pays. `compressExisting` renames the new file into place
   * and only then removes the old one, so a listing that raced the swap would measure a path that
   * is already gone and report a song that compressed perfectly as missing — a verdict the
   * renderer keeps for the rest of the session, since nothing re-derives `exists` on its own.
   */
  it('waits out an in-flight compression before measuring a song', async () => {
    let release!: () => void
    let swapped = false
    // The swap and the settle of the compression job are one moment: the rename lands, the record
    // is updated, and only then is a waiter let through.
    const gate = new Promise<void>((resolve) => {
      release = () => {
        swapped = true
        resolve()
      }
    })
    const harness = setup({ awaitCompression: (id) => (id === 'a' ? gate : undefined) })
    const added = await harness.libraryStore.add(draftSong({ id: 'a', fileName: 'a.m4a' }))
    const asRecorded = (): Song =>
      swapped ? { ...added, fileName: 'a.opus', compressed: true } : added
    vi.spyOn(harness.libraryStore, 'list').mockImplementation(async () => [asRecorded()])
    vi.spyOn(harness.libraryStore, 'getSong').mockImplementation(async () => asRecorded())
    // Only the post-swap file is on disk; the compressor removed the one the listing set out with.
    harness.fileSize.mockImplementation(async (absPath: string) =>
      absPath.endsWith('a.opus') ? 1234 : null
    )

    const pending = harness.invoke<SongDto[]>(IPC.library.list)
    // Releasing straight away would pass whether or not the gate is awaited, since the swap would
    // already have happened by the time the record is re-read. So prove the listener is *stuck*
    // first: the gate is the only thing here that is not already resolved, and the sentinel is a
    // macrotask, so a listing that had run to completion — its continuation being a microtask —
    // would win this race.
    const raced = Promise.race([
      pending.then(() => 'settled'),
      new Promise<string>((resolve) => setImmediate(() => resolve('waiting')))
    ])
    expect(await raced).toBe('waiting')

    release()

    const [dto] = await pending
    expect(dto.fileName).toBe('a.opus')
    expect(dto.exists).toBe(true)
    expect(dto.sizeBytes).toBe(1234)
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

    expect(dto).toEqual({
      ...added,
      title: 'Renamed',
      tags: ['x'],
      exists: true,
      url: dto.url,
      sizeBytes: 4096
    })
  })

  it('propagates NotFound for an unknown id', async () => {
    const harness = setup()

    await expect(
      harness.invoke(IPC.library.update, 'missing', { title: 'x' })
    ).rejects.toMatchObject({ name: 'NotFound' })
  })

  it('accepts a probed durationSec', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())

    const dto = await harness.invoke<SongDto>(IPC.library.update, added.id, { durationSec: 214.6 })

    expect(dto.durationSec).toBe(214.6)
    expect((await harness.libraryStore.getSong(added.id))?.durationSec).toBe(214.6)
  })

  it.each([
    ['', { title: 'x' }],
    [42, { title: 'x' }],
    ['id', undefined],
    ['id', { title: 7 }],
    ['id', { tags: 'x' }],
    ['id', { tags: [1] }],
    ['id', { durationSec: 'long' }],
    ['id', { durationSec: 0 }],
    ['id', { durationSec: -5 }],
    ['id', { durationSec: Number.NaN }],
    ['id', { durationSec: Number.POSITIVE_INFINITY }]
  ])('rejects a malformed payload (%s, %s)', async (id, patch) => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.update, id, patch)).rejects.toThrow()
  })
})

describe(IPC.library.updateDurations, () => {
  it('persists a batch and answers only the songs that still exist', async () => {
    const harness = setup()
    const a = await harness.libraryStore.add(draftSong({ title: 'A', fileName: 'a.wav' }))

    const dtos = await harness.invoke<SongDto[]>(IPC.library.updateDurations, [
      { id: a.id, durationSec: 173 },
      { id: 'ghost', durationSec: 9 }
    ])

    expect(dtos.map((d) => [d.id, d.durationSec])).toEqual([[a.id, 173]])
    expect((await harness.libraryStore.getSong(a.id))?.durationSec).toBe(173)
  })

  it('takes an empty batch as the nothing-to-write it is', async () => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.updateDurations, [])).resolves.toEqual([])
  })

  it('refuses a batch whose entries are malformed', async () => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.updateDurations, 'nope')).rejects.toThrow()
    await expect(harness.invoke(IPC.library.updateDurations, [null])).rejects.toThrow()
    await expect(
      harness.invoke(IPC.library.updateDurations, [{ id: '', durationSec: 3 }])
    ).rejects.toThrow()
    await expect(
      harness.invoke(IPC.library.updateDurations, [{ id: 'a', durationSec: 0 }])
    ).rejects.toThrow()
  })

  /** One bad entry is a bad payload: nothing in the batch is written, not even the good half. */
  it('writes none of a batch when one entry is malformed', async () => {
    const harness = setup()
    const a = await harness.libraryStore.add(draftSong())

    await expect(
      harness.invoke(IPC.library.updateDurations, [
        { id: a.id, durationSec: 173 },
        { id: 'b', durationSec: 'long' }
      ])
    ).rejects.toThrow()

    expect((await harness.libraryStore.getSong(a.id))?.durationSec).toBeUndefined()
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

  /**
   * `shell.trashItem` rejects for a path that is not there, so trashing first would make exactly
   * the rows the UI marks "File missing" the ones that can never be removed.
   */
  it('removes the row without trashing when the file is already gone', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())
    const playlist = await harness.playlistStore.create('P')
    await harness.playlistStore.addSong(playlist.id, added.id)
    harness.fileExists.mockResolvedValue(false)

    await harness.invoke(IPC.library.remove, added.id)

    expect(harness.trashItem).not.toHaveBeenCalled()
    expect(harness.fileExists).toHaveBeenCalledWith(path.join(lib.audio, added.fileName))
    expect(await harness.libraryStore.list()).toEqual([])
    expect((await harness.playlistStore.list())[0]?.songIds).toEqual([])
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

describe(IPC.library.compress, () => {
  it('delegates to the injected compressor and returns a fresh dto', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())

    const result = await harness.invoke<CompressResult>(IPC.library.compress, added.id)

    expect(harness.compressSong).toHaveBeenCalledExactlyOnceWith(added.id)
    expect(result.shrank).toBe(true)
    expect(result.song).toMatchObject({
      id: added.id,
      compressed: true,
      fileName: `${added.id}.opus`,
      exists: true,
      sizeBytes: 4096
    })
  })

  /**
   * A re-encode that came out no smaller is a success with nothing recorded, not a failure: the
   * dto is the song exactly as it already stood, and `shrank` is what tells the UI apart.
   */
  it('carries through a compression that kept the original', async () => {
    const harness = setup()
    const added = await harness.libraryStore.add(draftSong())
    harness.compressSong.mockResolvedValue({ song: added, shrank: false })

    const result = await harness.invoke<CompressResult>(IPC.library.compress, added.id)

    expect(result.shrank).toBe(false)
    expect(result.song).toMatchObject({
      id: added.id,
      compressed: false,
      fileName: 'song.wav',
      exists: true
    })
  })

  it('propagates what the compressor throws', async () => {
    const harness = setup()
    const alreadyCompressed = new Error('Song "X" is already compressed')
    alreadyCompressed.name = 'AlreadyCompressed'
    harness.compressSong.mockRejectedValue(alreadyCompressed)

    await expect(harness.invoke(IPC.library.compress, 'some-id')).rejects.toThrow(
      'already compressed'
    )
  })

  it.each([[''], [undefined], [42]])('rejects a malformed id (%s)', async (id) => {
    const harness = setup()

    await expect(harness.invoke(IPC.library.compress, id)).rejects.toThrow()
    expect(harness.compressSong).not.toHaveBeenCalled()
  })
})

describe(IPC.library.showFolder, () => {
  it('reveals the audio directory itself, with no payload', async () => {
    const harness = setup()

    await harness.invoke(IPC.library.showFolder)

    expect(harness.revealInFolder).toHaveBeenCalledExactlyOnceWith(lib.audio)
  })
})

describe('tag channels', () => {
  it('lists, creates, renames and removes', async () => {
    const harness = setup()

    expect(await harness.invoke<Tag[]>(IPC.tags.list)).toEqual([])

    const created = await harness.invoke<Tag>(IPC.tags.create, '  slowed ')
    expect(created).toMatchObject({
      name: 'slowed',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/)
    })

    const renamed = await harness.invoke<Tag>(IPC.tags.rename, created.id, 'slow')
    expect(renamed).toEqual({ ...created, name: 'slow' })

    await harness.invoke(IPC.tags.remove, created.id)
    expect(await harness.invoke<Tag[]>(IPC.tags.list)).toEqual([])
  })

  it('refuses a duplicate name with a message the renderer can show', async () => {
    const harness = setup()
    await harness.invoke<Tag>(IPC.tags.create, 'Slowed')

    await expect(harness.invoke(IPC.tags.create, 'slowed')).rejects.toThrow(
      'A tag named "Slowed" already exists'
    )
  })

  it.each([[''], ['   '], [undefined], [42]])(
    'rejects a malformed create payload (%s)',
    async (name) => {
      const harness = setup()

      await expect(harness.invoke(IPC.tags.create, name)).rejects.toThrow()
      expect(await harness.tagStore.list()).toEqual([])
    }
  )

  it.each([
    ['', 'x'],
    ['id', ''],
    [42, 'x']
  ])('rejects a malformed rename payload (%s, %s)', async (id, name) => {
    const harness = setup()

    await expect(harness.invoke(IPC.tags.rename, id, name)).rejects.toThrow()
  })

  /** The registry names a tag; the songs are what actually carry it, so a rename has to cascade. */
  it('renames the tag on every song that carries it', async () => {
    const harness = setup()
    const created = await harness.invoke<Tag>(IPC.tags.create, 'slowed')
    const first = await harness.libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))
    const second = await harness.libraryStore.add(draftSong({ tags: ['edit'] }))

    await harness.invoke<Tag>(IPC.tags.rename, created.id, 'slow')

    expect((await harness.libraryStore.getSong(first.id))?.tags).toEqual(['slow', 'edit'])
    expect((await harness.libraryStore.getSong(second.id))?.tags).toEqual(['edit'])
  })

  /** The cascade must use the name the tag had *before* the rename, not the new one. */
  it('cascades from the old name even when only the case changed', async () => {
    const harness = setup()
    const created = await harness.invoke<Tag>(IPC.tags.create, 'slowed')
    const song = await harness.libraryStore.add(draftSong({ tags: ['slowed'] }))

    await harness.invoke<Tag>(IPC.tags.rename, created.id, 'Slowed')

    expect((await harness.libraryStore.getSong(song.id))?.tags).toEqual(['Slowed'])
  })

  /** Opening the rename field, changing nothing and confirming must not wipe the tag. */
  it('leaves every song alone when a tag is renamed to the name it already has', async () => {
    const harness = setup()
    const created = await harness.invoke<Tag>(IPC.tags.create, 'slowed')
    const song = await harness.libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))

    const renamed = await harness.invoke<Tag>(IPC.tags.rename, created.id, 'slowed')

    expect(renamed).toEqual(created)
    expect((await harness.libraryStore.getSong(song.id))?.tags).toEqual(['slowed', 'edit'])
    expect(await harness.tagStore.list()).toEqual([created])
  })

  it('leaves the songs alone when the rename is refused', async () => {
    const harness = setup()
    await harness.invoke<Tag>(IPC.tags.create, 'reverb')
    const created = await harness.invoke<Tag>(IPC.tags.create, 'slowed')
    const song = await harness.libraryStore.add(draftSong({ tags: ['slowed'] }))

    await expect(harness.invoke(IPC.tags.rename, created.id, 'reverb')).rejects.toThrow()

    expect((await harness.libraryStore.getSong(song.id))?.tags).toEqual(['slowed'])
  })

  it('throws NotFound when renaming a tag that is not in the registry', async () => {
    const harness = setup()

    await expect(harness.invoke(IPC.tags.rename, 'missing', 'x')).rejects.toMatchObject({
      name: 'NotFound'
    })
  })

  it('drops the tag from every song when it is removed', async () => {
    const harness = setup()
    const created = await harness.invoke<Tag>(IPC.tags.create, 'slowed')
    const song = await harness.libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))

    await harness.invoke(IPC.tags.remove, created.id)

    expect((await harness.libraryStore.getSong(song.id))?.tags).toEqual(['edit'])
  })

  /** Removing something that is already gone is what the user wanted, so it is not an error. */
  it('says nothing and touches nothing when removing an unknown tag', async () => {
    const harness = setup()
    const song = await harness.libraryStore.add(draftSong({ tags: ['slowed'] }))

    await expect(harness.invoke(IPC.tags.remove, 'missing')).resolves.toBeUndefined()

    expect((await harness.libraryStore.getSong(song.id))?.tags).toEqual(['slowed'])
  })

  it.each([[''], [undefined], [42]])('rejects a malformed remove id (%s)', async (id) => {
    const harness = setup()

    await expect(harness.invoke(IPC.tags.remove, id)).rejects.toThrow()
  })
})

/**
 * A tag rename or delete replaces two files, and no filesystem commits two renames as one — so the
 * window between them cannot be closed, only pointed somewhere harmless. Which half a crash strands
 * is decided entirely by the order, and these tests watch that order directly.
 *
 * A crash is stood in for by making the *second* write reject, and the residue is read back through
 * **fresh** stores, which is what a restart is: a store caches its document for the life of the
 * process, so only the bytes on disk say what actually survived.
 */
describe('tag cascade ordering', () => {
  interface Cascade {
    libraryStore: LibraryStore
    tagStore: TagStore
    /** `'library'` then `'registry'`, in the order the two cascade writes were attempted. */
    order: string[]
    renameTag: ReturnType<typeof vi.fn>
    removeTag: ReturnType<typeof vi.fn>
    deps: Partial<LibraryIpcDeps>
  }

  /**
   * Real stores, with the library pass and the registry commit both announcing themselves. `crash`
   * makes the registry commit reject the way a lost power supply would — after the songs have
   * already moved.
   */
  function cascade({ crash = false } = {}): Cascade {
    const libraryStore = createLibraryStore(lib.root)
    const tagStore = createTagStore(lib.root)
    const order: string[] = []
    const renameTag = vi.fn(async (oldName: string, newName: string) => {
      order.push('library')
      await libraryStore.renameTag(oldName, newName)
    })
    const removeTag = vi.fn(async (name: string) => {
      order.push('library')
      await libraryStore.removeTag(name)
    })

    return {
      libraryStore,
      tagStore,
      order,
      renameTag,
      removeTag,
      deps: {
        libraryStore: { ...libraryStore, renameTag, removeTag },
        tagStore: {
          ...tagStore,
          async rename(id: string, name: string): Promise<Tag> {
            order.push('registry')
            if (crash) throw new Error('power lost')
            return tagStore.rename(id, name)
          },
          async remove(id: string): Promise<void> {
            order.push('registry')
            if (crash) throw new Error('power lost')
            await tagStore.remove(id)
          }
        }
      }
    }
  }

  const namesOnDisk = async (): Promise<string[]> =>
    (await createTagStore(lib.root).list()).map((tag) => tag.name)

  const libraryBytes = (): Promise<string> => readFile(libraryJsonPath(lib.root), 'utf8')

  it('writes the songs before it commits the registry on a rename', async () => {
    const { deps, order, tagStore, libraryStore } = cascade()
    const harness = setup(deps)
    const created = await tagStore.create('slowed')
    await libraryStore.add(draftSong({ tags: ['slowed'] }))

    await harness.invoke<Tag>(IPC.tags.rename, created.id, 'slow')

    expect(order).toEqual(['library', 'registry'])
  })

  it('writes the songs before it commits the registry on a remove', async () => {
    const { deps, order, tagStore, libraryStore } = cascade()
    const harness = setup(deps)
    const created = await tagStore.create('slowed')
    await libraryStore.add(draftSong({ tags: ['slowed'] }))

    await harness.invoke(IPC.tags.remove, created.id)

    expect(order).toEqual(['library', 'registry'])
  })

  /**
   * The tags dialog lists the registry and nothing else, so committing it first would tell the user
   * a rename succeeded while every song still carried the dead string — and nothing would prompt
   * the retry that repairs it. Stranding the other half leaves the tag plainly un-renamed.
   */
  it('leaves the registry holding the old name when a rename never reaches the commit', async () => {
    const { deps, tagStore, libraryStore } = cascade({ crash: true })
    const harness = setup(deps)
    const created = await tagStore.create('slowed')
    const song = await libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))

    await expect(harness.invoke(IPC.tags.rename, created.id, 'slow')).rejects.toThrow('power lost')

    expect(await namesOnDisk()).toEqual(['slowed'])
    expect((await createLibraryStore(lib.root).getSong(song.id))?.tags).toEqual(['slow', 'edit'])
  })

  /** Repeating the identical gesture *is* the repair: the library pass has nothing left to do. */
  it('converges when the interrupted rename is repeated', async () => {
    const crashed = cascade({ crash: true })
    const created = await crashed.tagStore.create('slowed')
    const song = await crashed.libraryStore.add(draftSong({ tags: ['slowed'] }))
    await expect(setup(crashed.deps).invoke(IPC.tags.rename, created.id, 'slow')).rejects.toThrow(
      'power lost'
    )

    // Fresh stores, the way the next launch would come up.
    const retry = cascade()
    const stranded = await libraryBytes()

    await setup(retry.deps).invoke<Tag>(IPC.tags.rename, created.id, 'slow')

    expect(retry.renameTag).toHaveBeenCalledTimes(1)
    expect(await libraryBytes()).toBe(stranded)
    expect(await namesOnDisk()).toEqual(['slow'])
    expect((await createLibraryStore(lib.root).getSong(song.id))?.tags).toEqual(['slow'])
  })

  /** The residue of an interrupted delete is an ordinary unused tag — with a Delete button on it. */
  it('leaves the tag listed when a remove never reaches the commit', async () => {
    const { deps, tagStore, libraryStore } = cascade({ crash: true })
    const harness = setup(deps)
    const created = await tagStore.create('slowed')
    const song = await libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))

    await expect(harness.invoke(IPC.tags.remove, created.id)).rejects.toThrow('power lost')

    await expect(createTagStore(lib.root).list()).resolves.toEqual([created])
    expect((await createLibraryStore(lib.root).getSong(song.id))?.tags).toEqual(['edit'])
  })

  it('converges when the interrupted remove is repeated', async () => {
    const crashed = cascade({ crash: true })
    const created = await crashed.tagStore.create('slowed')
    const song = await crashed.libraryStore.add(draftSong({ tags: ['slowed', 'edit'] }))
    await expect(setup(crashed.deps).invoke(IPC.tags.remove, created.id)).rejects.toThrow(
      'power lost'
    )

    const retry = cascade()
    const stranded = await libraryBytes()

    await setup(retry.deps).invoke(IPC.tags.remove, created.id)

    expect(retry.removeTag).toHaveBeenCalledTimes(1)
    expect(await libraryBytes()).toBe(stranded)
    await expect(createTagStore(lib.root).list()).resolves.toEqual([])
    expect((await createLibraryStore(lib.root).getSong(song.id))?.tags).toEqual(['edit'])
  })

  /**
   * Cascading first must not cost the clash check: `resolveRename` answers it without writing, so a
   * refused rename still never touches `library.json`.
   */
  it('refuses a clashing rename before a single song moves', async () => {
    const { deps, renameTag, tagStore, libraryStore } = cascade()
    const harness = setup(deps)
    await tagStore.create('reverb')
    const created = await tagStore.create('slowed')
    await libraryStore.add(draftSong({ tags: ['slowed'] }))
    const before = await libraryBytes()

    await expect(harness.invoke(IPC.tags.rename, created.id, 'REVERB')).rejects.toThrow(
      'A tag named "reverb" already exists'
    )

    expect(renameTag).not.toHaveBeenCalled()
    expect(await libraryBytes()).toBe(before)
  })

  /** The reorder's easy mistake: cascading the raw payload instead of the name the registry keeps. */
  it('cascades the trimmed name onto the songs', async () => {
    const { deps, renameTag, tagStore, libraryStore } = cascade()
    const harness = setup(deps)
    const created = await tagStore.create('slowed')
    const song = await libraryStore.add(draftSong({ tags: ['slowed'] }))

    const renamed = await harness.invoke<Tag>(IPC.tags.rename, created.id, '  slow  ')

    expect(renamed.name).toBe('slow')
    expect(renameTag).toHaveBeenCalledWith('slowed', 'slow')
    expect((await libraryStore.getSong(song.id))?.tags).toEqual(['slow'])
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

  /** The sidebar's order is this array's order, so rearranging it is a write like any other. */
  it('reorders the playlists and hands back the stored order', async () => {
    const harness = setup()
    const first = await harness.invoke<Playlist>(IPC.playlists.create, 'First')
    const second = await harness.invoke<Playlist>(IPC.playlists.create, 'Second')
    const third = await harness.invoke<Playlist>(IPC.playlists.create, 'Third')

    const reordered = await harness.invoke<Playlist[]>(IPC.playlists.reorder, [
      third.id,
      first.id,
      second.id
    ])

    expect(reordered.map((playlist) => playlist.name)).toEqual(['Third', 'First', 'Second'])
    expect((await harness.playlistStore.list()).map((playlist) => playlist.name)).toEqual([
      'Third',
      'First',
      'Second'
    ])
  })

  it.each([
    [IPC.playlists.create, ['']],
    [IPC.playlists.create, [42]],
    [IPC.playlists.rename, ['id', '']],
    [IPC.playlists.remove, [undefined]],
    [IPC.playlists.reorder, [undefined]],
    [IPC.playlists.reorder, ['p1']],
    [IPC.playlists.reorder, [[1]]],
    [IPC.playlists.reorder, [['']]],
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
