import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { playlistsJsonPath } from '../paths'
import type { Playlist, PlaylistsFile, Song } from '../../shared/types'
import { ConflictError, NotFoundError } from './errors'
import { createLibraryStore } from './libraryStore'
import { createPlaylistStore } from './playlistStore'

function song(title: string): Song {
  return { id: '', fileName: `${title}.wav`, title, tags: [], addedAt: '', compressed: false }
}

let lib: TmpLibrary

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

describe('create', () => {
  it('assigns an id and createdAt and starts empty, unshuffled and unrepeated', async () => {
    const store = createPlaylistStore(lib.root)

    const created = await store.create('Late night')

    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string,
      name: 'Late night',
      songIds: [],
      shuffle: false,
      repeat: false,
      createdAt: expect.any(String) as unknown as string
    })
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
  })

  it('persists across a re-open and writes a versioned file', async () => {
    const created = await createPlaylistStore(lib.root).create('Gym')

    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([created])

    const file = JSON.parse(await readFile(playlistsJsonPath(lib.root), 'utf8')) as PlaylistsFile
    expect(file.version).toBe(1)
  })

  it('starts empty when playlists.json is corrupt', async () => {
    await writeFile(playlistsJsonPath(lib.root), '{ broken', 'utf8')

    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([])
  })
})

describe('rename', () => {
  it('renames and persists', async () => {
    const store = createPlaylistStore(lib.root)
    const created = await store.create('Old')

    const renamed = await store.rename(created.id, 'New')

    expect(renamed).toEqual({ ...created, name: 'New' })
    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([renamed])
  })

  it('throws NotFound for an unknown playlist', async () => {
    await expect(createPlaylistStore(lib.root).rename('missing', 'x')).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('addSong', () => {
  it('adds a song once, however many times it is added', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')

    await store.addSong(playlist.id, 'song-1')
    const twice = await store.addSong(playlist.id, 'song-1')

    expect(twice.songIds).toEqual(['song-1'])
  })

  it('preserves insertion order', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')

    await store.addSong(playlist.id, 'a')
    await store.addSong(playlist.id, 'b')
    const third = await store.addSong(playlist.id, 'c')

    expect(third.songIds).toEqual(['a', 'b', 'c'])
    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([third])
  })

  it('throws NotFound for an unknown playlist', async () => {
    const store = createPlaylistStore(lib.root)

    await expect(store.addSong('missing', 'song-1')).rejects.toBeInstanceOf(NotFoundError)
    await expect(store.addSong('missing', 'song-1')).rejects.toMatchObject({ name: 'NotFound' })
  })
})

describe('removeSong', () => {
  it('removes only the given song and persists', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, 'a')
    await store.addSong(playlist.id, 'b')

    const after = await store.removeSong(playlist.id, 'a')

    expect(after.songIds).toEqual(['b'])
    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([after])
  })

  it('throws NotFound for an unknown playlist', async () => {
    await expect(createPlaylistStore(lib.root).removeSong('missing', 'a')).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('remove', () => {
  it('drops the playlist and leaves the library untouched', async () => {
    const library = createLibraryStore(lib.root)
    const kept = await library.add(song('kept'))
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, kept.id)

    await store.remove(playlist.id)

    expect(await store.list()).toEqual([])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([kept])
  })

  it('is a no-op for an unknown playlist', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')

    await expect(store.remove('missing')).resolves.toBeUndefined()
    expect(await store.list()).toEqual([playlist])
  })
})

describe('cascadeRemoveSong', () => {
  it('strips the id from every playlist and leaves the others intact', async () => {
    const store = createPlaylistStore(lib.root)
    const first = await store.create('First')
    const second = await store.create('Second')
    const third = await store.create('Third')
    await store.addSong(first.id, 'doomed')
    await store.addSong(first.id, 'keeper')
    await store.addSong(second.id, 'doomed')
    await store.addSong(third.id, 'keeper')

    await store.cascadeRemoveSong('doomed')

    const byName = new Map((await store.list()).map((p) => [p.name, p]))
    expect(byName.get('First')?.songIds).toEqual(['keeper'])
    expect(byName.get('Second')?.songIds).toEqual([])
    expect(byName.get('Third')?.songIds).toEqual(['keeper'])
    const reopened = await createPlaylistStore(lib.root).list()
    expect(reopened.map((p) => p.songIds)).toEqual([['keeper'], [], ['keeper']])
  })

  it('is a no-op when no playlist references the song', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, 'a')

    await store.cascadeRemoveSong('not-there')

    expect((await store.list())[0]?.songIds).toEqual(['a'])
  })
})

describe('setPlaybackOptions', () => {
  it('persists shuffle and repeat independently', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')

    const shuffled = await store.setPlaybackOptions(playlist.id, { shuffle: true })
    expect(shuffled).toEqual({ ...playlist, shuffle: true })

    const repeated = await store.setPlaybackOptions(playlist.id, { repeat: true })
    expect(repeated).toEqual({ ...playlist, shuffle: true, repeat: true })

    const unshuffled = await store.setPlaybackOptions(playlist.id, { shuffle: false })
    expect(unshuffled).toEqual({ ...playlist, shuffle: false, repeat: true })

    await expect(createPlaylistStore(lib.root).list()).resolves.toEqual([unshuffled])
  })

  it('throws NotFound for an unknown playlist', async () => {
    await expect(
      createPlaylistStore(lib.root).setPlaybackOptions('missing', { shuffle: true })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('reorder', () => {
  it('applies and persists the new order', async () => {
    const store = createPlaylistStore(lib.root)
    const a = await store.create('Alpha')
    const b = await store.create('Bravo')
    const c = await store.create('Chill')

    const next = await store.reorder([c.id, a.id, b.id])

    expect(next.map((p) => p.name)).toEqual(['Chill', 'Alpha', 'Bravo'])
    // A second store over the same dir reads the same order back off disk.
    const reread = createPlaylistStore(lib.root)
    expect((await reread.list()).map((p) => p.name)).toEqual(['Chill', 'Alpha', 'Bravo'])
  })

  it('rejects an order that does not name every playlist exactly once', async () => {
    const store = createPlaylistStore(lib.root)
    const a = await store.create('Alpha')
    const b = await store.create('Bravo')

    await expect(store.reorder([a.id])).rejects.toBeInstanceOf(ConflictError)
    await expect(store.reorder([a.id, a.id])).rejects.toBeInstanceOf(ConflictError)
    await expect(store.reorder([a.id, 'nope'])).rejects.toBeInstanceOf(NotFoundError)

    // A failed reorder leaves the order alone.
    expect((await store.list()).map((p) => p.id)).toEqual([a.id, b.id])
  })

  it('rejects a duplicated id even when every playlist is named', async () => {
    const store = createPlaylistStore(lib.root)
    const a = await store.create('Alpha')
    const b = await store.create('Bravo')

    // A set of the names alone cannot catch this one: {a, b} covers both playlists, but applying
    // the raw list would write Alpha twice and grow the file by one.
    await expect(store.reorder([a.id, a.id, b.id])).rejects.toBeInstanceOf(ConflictError)
    expect((await store.list()).map((p) => p.id)).toEqual([a.id, b.id])
  })
})

describe('reorderSongs', () => {
  it('applies and persists the new song order', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, 'a')
    await store.addSong(playlist.id, 'b')
    await store.addSong(playlist.id, 'c')

    const next = await store.reorderSongs(playlist.id, ['c', 'a', 'b'])

    expect(next.songIds).toEqual(['c', 'a', 'b'])
    // A second store over the same dir reads the same order back off disk.
    expect((await createPlaylistStore(lib.root).list())[0]?.songIds).toEqual(['c', 'a', 'b'])
  })

  it('rejects an order that does not name every song exactly once', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, 'a')
    await store.addSong(playlist.id, 'b')

    await expect(store.reorderSongs(playlist.id, ['a'])).rejects.toBeInstanceOf(ConflictError)
    // The duplicate covers every name, so only the length gives it away.
    await expect(store.reorderSongs(playlist.id, ['a', 'a', 'b'])).rejects.toBeInstanceOf(
      ConflictError
    )
    await expect(store.reorderSongs(playlist.id, ['a', 'nope'])).rejects.toBeInstanceOf(
      NotFoundError
    )

    // A failed reorder leaves the order alone.
    expect((await store.list())[0]?.songIds).toEqual(['a', 'b'])
  })

  it('names the submitted unknown id, never a stored one', async () => {
    const store = createPlaylistStore(lib.root)
    const playlist = await store.create('P')
    await store.addSong(playlist.id, 'a')
    await store.addSong(playlist.id, 'b')

    await expect(store.reorderSongs(playlist.id, ['a', 'nope'])).rejects.toThrow(
      'No song with id "nope"'
    )
  })

  it('rejects an order that smuggles an unknown id past a duplicated stored id', async () => {
    // A duplicate can only arrive from outside the app — the validator accepts any string array.
    const stored: PlaylistsFile = {
      version: 1,
      playlists: [
        {
          id: 'p1',
          name: 'Dup',
          songIds: ['a', 'a', 'b'],
          shuffle: false,
          repeat: false,
          createdAt: new Date().toISOString()
        }
      ]
    }
    await writeFile(playlistsJsonPath(lib.root), JSON.stringify(stored), 'utf8')
    const store = createPlaylistStore(lib.root)

    await expect(store.reorderSongs('p1', ['a', 'b', 'zzz'])).rejects.toBeInstanceOf(NotFoundError)

    const file = JSON.parse(await readFile(playlistsJsonPath(lib.root), 'utf8')) as PlaylistsFile
    expect(file.playlists[0]?.songIds).toEqual(['a', 'a', 'b'])
  })

  it('throws NotFound for an unknown playlist', async () => {
    await expect(createPlaylistStore(lib.root).reorderSongs('missing', [])).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('failed writes', () => {
  /** Makes the next persist fail: the atomic rename cannot land on a directory. */
  async function blockWrites(): Promise<void> {
    await rm(playlistsJsonPath(lib.root), { force: true })
    await mkdir(playlistsJsonPath(lib.root))
  }

  it('a failed persist leaves the cached playlist unchanged', async () => {
    const store = createPlaylistStore(lib.root)
    const created = await store.create('Before')
    await blockWrites()

    await expect(store.rename(created.id, 'After')).rejects.toThrow()
    expect((await store.list())[0]?.name).toBe('Before')
  })

  it('a failed persist leaves the cached order alone', async () => {
    const store = createPlaylistStore(lib.root)
    const a = await store.create('Alpha')
    const b = await store.create('Bravo')
    await blockWrites()

    await expect(store.reorder([b.id, a.id])).rejects.toThrow()
    expect((await store.list()).map((p) => p.id)).toEqual([a.id, b.id])
  })
})

describe('cache isolation', () => {
  it('does not let callers mutate the store through returned playlists', async () => {
    const store = createPlaylistStore(lib.root)
    const created: Playlist = await store.create('P')
    await store.addSong(created.id, 'a')

    const listed = await store.list()
    listed[0]?.songIds.push('injected')

    expect((await store.list())[0]?.songIds).toEqual(['a'])
  })
})
