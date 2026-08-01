import { describe, expect, it, vi } from 'vitest'
import type { Playlist, SongDto } from '../../src/shared/types'
import { createMockApi, mockApiControls } from './mockApi'

const song = (id: string): SongDto => ({
  id,
  fileName: `${id}.mp3`,
  title: `Song ${id}`,
  tags: [],
  addedAt: '2026-01-01T00:00:00.000Z',
  compressed: false,
  exists: true,
  url: `media://audio/${id}`
})

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
