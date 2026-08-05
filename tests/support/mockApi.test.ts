import { describe, expect, it, vi } from 'vitest'
import type { Playlist, Tag } from '../../src/shared/types'
import { createMockApi, mockApiControls, type MockApiSeedSong } from './mockApi'

const song = (id: string, extra: Partial<MockApiSeedSong> = {}): MockApiSeedSong => ({
  id,
  fileName: `${id}.mp3`,
  title: `Song ${id}`,
  tags: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  compressed: false,
  exists: true,
  url: `media://audio/${id}`,
  ...extra
})

const tag = (id: string, name: string): Tag => ({ id, name, color: '#123456' })

const playlist = (id: string, songIds: string[]): Playlist => ({
  id,
  name: `Playlist ${id}`,
  songIds,
  shuffle: false,
  repeat: false,
  createdAt: '2026-01-01T00:00:00.000Z'
})

describe('createMockApi', () => {
  it('serves the seeded library, playlists and settings', async () => {
    const api = createMockApi({
      songs: [song('a')],
      playlists: [playlist('p', ['a'])],
      settings: { volume: 0.25 }
    })

    await expect(api.library.list()).resolves.toMatchObject([{ id: 'a' }])
    await expect(api.playlists.list()).resolves.toMatchObject([{ id: 'p', songIds: ['a'] }])
    await expect(api.settings.get()).resolves.toMatchObject({ volume: 0.25, version: 1 })
  })

  it('never hands out an array it still holds a reference to', async () => {
    const api = createMockApi({ songs: [song('a')], playlists: [playlist('p', ['a'])] })

    const [listedSong] = await api.library.list()
    listedSong.tags.push('injected')
    const [listedPlaylist] = await api.playlists.list()
    listedPlaylist.songIds.push('bogus')

    const added = await api.library.add({
      sourcePath: '/tmp/x.wav',
      title: 'x',
      tags: ['keep'],
      compress: false
    })
    added.tags.push('injected')

    const updated = await api.library.update('a', { tags: ['fresh'] })
    updated.tags.push('injected')

    await expect(api.library.list()).resolves.toMatchObject([
      { id: 'a', tags: ['fresh'] },
      { tags: ['keep'] }
    ])
    await expect(api.playlists.list()).resolves.toMatchObject([{ songIds: ['a'] }])
  })

  it('does not let seeded objects and mock state alias each other', async () => {
    const seeded = song('a')
    const seededPlaylist = playlist('p', ['a'])
    const api = createMockApi({ songs: [seeded], playlists: [seededPlaylist] })

    await api.library.update('a', { tags: ['added-inside'] })
    seeded.tags.push('added-outside')
    seededPlaylist.songIds.push('added-outside')

    await expect(api.library.list()).resolves.toMatchObject([{ tags: ['added-inside'] }])
    await expect(api.playlists.list()).resolves.toMatchObject([{ songIds: ['a'] }])
  })

  it('removes a song from every playlist that referenced it', async () => {
    const api = createMockApi({ songs: [song('a')], playlists: [playlist('p', ['a'])] })

    await api.library.remove('a')

    await expect(api.library.list()).resolves.toEqual([])
    await expect(api.playlists.list()).resolves.toMatchObject([{ songIds: [] }])
  })

  it('records calls, so failures can be forced per test', async () => {
    const api = createMockApi()
    vi.mocked(api.library.list).mockRejectedValueOnce(new Error('disk on fire'))

    await expect(api.library.list()).rejects.toThrow('disk on fire')
    expect(api.library.list).toHaveBeenCalledTimes(1)
  })

  it('delivers download progress until the subscriber unsubscribes', () => {
    const api = createMockApi()
    const seen: number[] = []
    const unsubscribe = api.download.onProgress((p) => seen.push(p.percent ?? -1))

    mockApiControls(api).emitDownloadProgress({ stage: 'downloading', percent: 10 })
    unsubscribe()
    mockApiControls(api).emitDownloadProgress({ stage: 'downloading', percent: 90 })

    expect(seen).toEqual([10])
  })

  it('emits libraryChanged on mutation and on demand', async () => {
    const api = createMockApi()
    const changed = vi.fn()
    const unsubscribe = api.events.onLibraryChanged(changed)

    await api.library.add({ sourcePath: '/tmp/x.wav', title: 'x', tags: [], compress: false })
    expect(changed).toHaveBeenCalledTimes(1)

    mockApiControls(api).emitLibraryChanged()
    expect(changed).toHaveBeenCalledTimes(2)

    unsubscribe()
    mockApiControls(api).emitLibraryChanged()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('emits errors to subscribers', () => {
    const api = createMockApi()
    const onError = vi.fn()
    api.events.onError(onError)

    mockApiControls(api).emitError({ source: 'ytdlp', message: 'nope' })

    expect(onError).toHaveBeenCalledWith({ source: 'ytdlp', message: 'nope' })
  })

  it('refuses to hand out controls for something it did not create', () => {
    expect(() => mockApiControls({} as ReturnType<typeof createMockApi>)).toThrow(/createMockApi/)
  })
})

describe('song size and duration', () => {
  it('gives a seeded song a plausible size and no duration until one is recorded', async () => {
    const api = createMockApi({ songs: [song('a')] })

    const [listed] = await api.library.list()

    expect(listed.sizeBytes).toBe(4_000_000)
    expect(listed).not.toHaveProperty('durationSec')
  })

  it('keeps a size the seed asked for, including a missing file', async () => {
    const api = createMockApi({
      songs: [song('a', { sizeBytes: 17 }), song('b', { exists: false, sizeBytes: null })]
    })

    await expect(api.library.list()).resolves.toMatchObject([
      { sizeBytes: 17 },
      { sizeBytes: null }
    ])
  })

  /**
   * `sizeBytes` is null exactly when `exists` is false — the invariant both DTO producers in the
   * main process uphold. A seed that says the file is gone but forgets the null would otherwise
   * hand the UI a weight for a file that is not there.
   */
  it('gives a seeded missing file a null size rather than the default weight', () => {
    const api = createMockApi({ songs: [song('a', { exists: false })] })

    expect(mockApiControls(api).state.songs[0].sizeBytes).toBeNull()
  })

  it('records a probed durationSec through library.update', async () => {
    const api = createMockApi({ songs: [song('a')] })

    await expect(api.library.update('a', { durationSec: 214 })).resolves.toMatchObject({
      durationSec: 214
    })
    await expect(api.library.list()).resolves.toMatchObject([{ durationSec: 214 }])
  })

  /** The batched write skips ids it does not know rather than throwing the way `update` does. */
  it('records a whole batch of durations and passes over ids it does not have', async () => {
    const api = createMockApi({ songs: [song('a'), song('b')] })

    const updated = await api.library.updateDurations([
      { id: 'a', durationSec: 173 },
      { id: 'ghost', durationSec: 9 },
      { id: 'b', durationSec: 41 }
    ])

    expect(updated.map((s) => [s.id, s.durationSec])).toEqual([
      ['a', 173],
      ['b', 41]
    ])
    await expect(api.library.list()).resolves.toMatchObject([
      { id: 'a', durationSec: 173 },
      { id: 'b', durationSec: 41 }
    ])
  })

  it('announces a batch that changed something and stays quiet about one that did not', async () => {
    const api = createMockApi({ songs: [song('a')] })
    const changed = vi.fn()
    api.events.onLibraryChanged(changed)

    await api.library.updateDurations([{ id: 'ghost', durationSec: 9 }])
    expect(changed).not.toHaveBeenCalled()

    await api.library.updateDurations([{ id: 'a', durationSec: 173 }])
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('library.compress', () => {
  it('marks the song compressed, renames the file and shrinks the reported size', async () => {
    const api = createMockApi({ songs: [song('a', { sizeBytes: 5_000_001 })] })

    const compressed = await api.library.compress('a')

    expect(compressed).toMatchObject({
      compressed: true,
      fileName: 'a.opus',
      sizeBytes: 3_750_001
    })
    await expect(api.library.list()).resolves.toMatchObject([{ compressed: true }])
  })

  it('rejects for an unknown song', async () => {
    const api = createMockApi()

    await expect(api.library.compress('nope')).rejects.toThrow(/nope/)
  })
})

describe('library.showFolder', () => {
  it('records the request', async () => {
    const api = createMockApi()

    await api.library.showFolder()

    expect(api.library.showFolder).toHaveBeenCalledTimes(1)
  })
})

describe('tags', () => {
  it('serves the seeded registry and creates new tags with a colour', async () => {
    const api = createMockApi({ tags: [tag('t1', 'slowed')] })

    await expect(api.tags.list()).resolves.toEqual([tag('t1', 'slowed')])

    const created = await api.tags.create('  reverb  ')

    expect(created.name).toBe('reverb')
    expect(created.color).toMatch(/^#[0-9a-f]{6}$/)
    await expect(api.tags.list()).resolves.toHaveLength(2)
  })

  it('refuses an empty name and a duplicate whatever its case', async () => {
    const api = createMockApi({ tags: [tag('t1', 'slowed')] })

    await expect(api.tags.create('   ')).rejects.toThrow()
    await expect(api.tags.create('SLOWED')).rejects.toThrow(/already exists/)
    await expect(api.tags.list()).resolves.toHaveLength(1)
  })

  it('renames the tag on every song that carries it', async () => {
    const api = createMockApi({
      tags: [tag('t1', 'slowed')],
      songs: [song('a', { tags: ['slowed', 'edit'] }), song('b', { tags: ['edit'] })]
    })

    const renamed = await api.tags.rename('t1', 'slow')

    expect(renamed).toMatchObject({ id: 't1', name: 'slow' })
    await expect(api.library.list()).resolves.toMatchObject([
      { tags: ['slow', 'edit'] },
      { tags: ['edit'] }
    ])
  })

  /** Mirrors `libraryStore.renameTag`: renaming to the same name must not wipe the tag. */
  it('leaves every song alone when a tag is renamed to the name it already has', async () => {
    const api = createMockApi({
      tags: [tag('t1', 'slowed')],
      songs: [song('a', { tags: ['slowed', 'edit'] })]
    })

    await expect(api.tags.rename('t1', 'slowed')).resolves.toMatchObject({ name: 'slowed' })

    await expect(api.library.list()).resolves.toMatchObject([{ tags: ['slowed', 'edit'] }])
  })

  it('drops the tag from every song when it is removed', async () => {
    const api = createMockApi({
      tags: [tag('t1', 'slowed')],
      songs: [song('a', { tags: ['slowed', 'edit'] })]
    })

    await api.tags.remove('t1')

    await expect(api.tags.list()).resolves.toEqual([])
    await expect(api.library.list()).resolves.toMatchObject([{ tags: ['edit'] }])
  })

  it('is a no-op when removing a tag that is not there', async () => {
    const api = createMockApi({ tags: [tag('t1', 'slowed')] })

    await expect(api.tags.remove('gone')).resolves.toBeUndefined()
    await expect(api.tags.list()).resolves.toHaveLength(1)
  })

  it('never hands out a tag it still holds a reference to', async () => {
    const api = createMockApi({ tags: [tag('t1', 'slowed')] })

    const [listed] = await api.tags.list()
    listed.name = 'injected'

    await expect(api.tags.list()).resolves.toMatchObject([{ name: 'slowed' }])
  })
})
