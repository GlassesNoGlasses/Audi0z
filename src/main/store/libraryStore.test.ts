import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { libraryJsonPath } from '../paths'
import type { LibraryFile, Song } from '../../shared/types'
import { NotFoundError } from './errors'
import { createLibraryStore } from './libraryStore'

function draft(overrides: Partial<Song> = {}): Song {
  return {
    id: '',
    fileName: 'song.wav',
    title: 'A Song',
    tags: ['chill'],
    addedAt: '',
    compressed: false,
    ...overrides
  }
}

async function readLibraryFile(root: string): Promise<LibraryFile> {
  return JSON.parse(await readFile(libraryJsonPath(root), 'utf8')) as LibraryFile
}

let lib: TmpLibrary

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

describe('createLibraryStore', () => {
  it('starts empty when there is no library.json', async () => {
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([])
  })

  it('falls back to an empty library when library.json is corrupt', async () => {
    await writeFile(libraryJsonPath(lib.root), 'not json at all', 'utf8')

    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([])
    expect(await readFile(`${libraryJsonPath(lib.root)}.bak`, 'utf8')).toBe('not json at all')
  })
})

describe('add', () => {
  it('assigns a uuid and an ISO addedAt, and persists across a re-open', async () => {
    const store = createLibraryStore(lib.root)

    const added = await store.add(draft({ title: 'Nightdrive' }))

    expect(added.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(new Date(added.addedAt).toISOString()).toBe(added.addedAt)

    const reopened = await createLibraryStore(lib.root).list()
    expect(reopened).toEqual([added])
  })

  it('assigns a uuid and addedAt when the caller omits them entirely', async () => {
    const store = createLibraryStore(lib.root)
    const partial = { fileName: 'x.opus', title: 'X', tags: [], compressed: true }

    const added = await store.add(partial as unknown as Song)

    expect(added.id).not.toBe('')
    expect(added.addedAt).not.toBe('')
  })

  it('keeps an id and addedAt supplied by the caller', async () => {
    const store = createLibraryStore(lib.root)

    const added = await store.add(
      draft({ id: 'given-id', addedAt: '2020-01-01T00:00:00.000Z', sourceUrl: 'https://x.test/1' })
    )

    expect(added.id).toBe('given-id')
    expect(added.addedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(added.sourceUrl).toBe('https://x.test/1')
  })

  it('writes a versioned library file', async () => {
    const store = createLibraryStore(lib.root)
    await store.add(draft())

    const file = await readLibraryFile(lib.root)
    expect(file.version).toBe(1)
    expect(file.songs).toHaveLength(1)
  })

  it('keeps insertion order', async () => {
    const store = createLibraryStore(lib.root)
    await store.add(draft({ title: 'one' }))
    await store.add(draft({ title: 'two' }))
    await store.add(draft({ title: 'three' }))

    expect((await store.list()).map((song) => song.title)).toEqual(['one', 'two', 'three'])
  })
})

describe('getSong', () => {
  it('returns the added song and undefined for an unknown id', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())

    await expect(store.getSong(added.id)).resolves.toEqual(added)
    await expect(store.getSong('nope')).resolves.toBeUndefined()
  })

  it('sees songs written by another store instance against the same directory', async () => {
    const added = await createLibraryStore(lib.root).add(draft())

    await expect(createLibraryStore(lib.root).getSong(added.id)).resolves.toEqual(added)
  })
})

describe('update', () => {
  it('patches title and tags only', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ title: 'old', tags: ['a'] }))

    const updated = await store.update(added.id, { title: 'new', tags: ['b', 'c'] })

    expect(updated).toEqual({ ...added, title: 'new', tags: ['b', 'c'] })
    await expect(createLibraryStore(lib.root).getSong(added.id)).resolves.toEqual(updated)
  })

  it('leaves untouched fields alone when the patch is partial', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ title: 'old', tags: ['a'] }))

    expect(await store.update(added.id, { tags: ['b'] })).toEqual({ ...added, tags: ['b'] })
    expect(await store.update(added.id, { title: 'newer' })).toEqual({
      ...added,
      title: 'newer',
      tags: ['b']
    })
  })

  it('ignores fields outside title and tags', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())

    const updated = await store.update(added.id, {
      title: 'renamed',
      fileName: 'hacked.wav',
      id: 'hacked'
    } as Partial<Pick<Song, 'title' | 'tags'>>)

    expect(updated.fileName).toBe(added.fileName)
    expect(updated.id).toBe(added.id)
  })

  it('throws NotFound for an unknown id', async () => {
    const store = createLibraryStore(lib.root)

    await expect(store.update('missing', { title: 'x' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(store.update('missing', { title: 'x' })).rejects.toMatchObject({
      name: 'NotFound'
    })
  })
})

describe('remove', () => {
  it('drops the entry and persists the removal', async () => {
    const store = createLibraryStore(lib.root)
    const first = await store.add(draft({ title: 'first' }))
    const second = await store.add(draft({ title: 'second' }))

    await store.remove(first.id)

    expect(await store.list()).toEqual([second])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([second])
    await expect(store.getSong(first.id)).resolves.toBeUndefined()
  })

  it('is a no-op for an unknown id', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())

    await expect(store.remove('missing')).resolves.toBeUndefined()
    expect(await store.list()).toEqual([added])
  })
})

describe('cache isolation', () => {
  it('does not let callers mutate the store through returned objects', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ tags: ['keep'] }))

    const listed = await store.list()
    listed.pop()
    const fetched = await store.getSong(added.id)
    fetched?.tags.push('injected')

    expect(await store.list()).toEqual([added])
    await expect(store.getSong(added.id)).resolves.toEqual(added)
  })
})
