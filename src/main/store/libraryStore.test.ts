import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { libraryJsonPath } from '../paths'
import type { LibraryFile, Song } from '../../shared/types'
import { NotFoundError } from './errors'
import { writeJsonFile } from './jsonFile'
import { createLibraryStore } from './libraryStore'

/**
 * The real writer, wrapped in a spy: the tag cascades promise ONE write for the whole library pass
 * (and none at all when nothing matched), which is only observable by counting calls.
 */
vi.mock('./jsonFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jsonFile')>()
  return { ...actual, writeJsonFile: vi.fn(actual.writeJsonFile) }
})

/** Call count of `writeJsonFile` since the last `resetWrites()`. */
function writeCount(): number {
  return vi.mocked(writeJsonFile).mock.calls.length
}

function resetWrites(): void {
  vi.mocked(writeJsonFile).mockClear()
}

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

describe('update: durationSec', () => {
  it('records a probed duration and persists it', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())

    const updated = await store.update(added.id, { durationSec: 214 })

    expect(updated).toEqual({ ...added, durationSec: 214 })
    await expect(createLibraryStore(lib.root).getSong(added.id)).resolves.toEqual(updated)
  })

  it('leaves a recorded duration alone when a later patch does not mention it', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())
    await store.update(added.id, { durationSec: 214 })

    expect(await store.update(added.id, { title: 'Renamed' })).toMatchObject({ durationSec: 214 })
  })

  /** A hand-edited `library.json` must not lose every song over one bad field. */
  it('loads a song whose durationSec is present and drops a file where it is not a number', async () => {
    const withDuration: LibraryFile = {
      version: 1,
      songs: [{ ...draft({ id: 'a' }), durationSec: 12 }]
    }
    await writeFile(libraryJsonPath(lib.root), JSON.stringify(withDuration), 'utf8')
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual(withDuration.songs)

    await writeFile(
      libraryJsonPath(lib.root),
      JSON.stringify({ version: 1, songs: [{ ...draft({ id: 'a' }), durationSec: 'long' }] }),
      'utf8'
    )
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([])
  })
})

describe('renameTag', () => {
  it('rewrites the tag on every song that carries it, in a single write', async () => {
    const store = createLibraryStore(lib.root)
    const first = await store.add(draft({ title: 'first', tags: ['slowed', 'edit'] }))
    const second = await store.add(draft({ title: 'second', tags: ['edit'] }))
    const third = await store.add(draft({ title: 'third', tags: ['slowed'] }))
    resetWrites()

    await store.renameTag('slowed', 'slow')

    expect(writeCount()).toBe(1)
    expect((await store.list()).map((song) => song.tags)).toEqual([
      ['slow', 'edit'],
      ['edit'],
      ['slow']
    ])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([
      { ...first, tags: ['slow', 'edit'] },
      second,
      { ...third, tags: ['slow'] }
    ])
  })

  /** Renaming onto a tag a song already has must merge, not leave the song holding it twice. */
  it('drops the old name rather than duplicating when the song already has the new one', async () => {
    const store = createLibraryStore(lib.root)
    await store.add(draft({ tags: ['slowed', 'slow', 'edit'] }))
    resetWrites()

    await store.renameTag('slowed', 'slow')

    expect(writeCount()).toBe(1)
    expect((await store.list())[0].tags).toEqual(['slow', 'edit'])
  })

  it('matches the tag exactly, leaving near-misses alone', async () => {
    const store = createLibraryStore(lib.root)
    await store.add(draft({ tags: ['Slowed', 'slowed-2'] }))

    await store.renameTag('slowed', 'slow')

    expect((await store.list())[0].tags).toEqual(['Slowed', 'slowed-2'])
  })

  it('writes nothing when no song carries the tag', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ tags: ['edit'] }))
    resetWrites()

    await store.renameTag('slowed', 'slow')

    expect(writeCount()).toBe(0)
    expect(await store.list()).toEqual([added])
  })
})

describe('removeTag', () => {
  it('drops the tag from every song in a single write', async () => {
    const store = createLibraryStore(lib.root)
    await store.add(draft({ title: 'first', tags: ['slowed', 'edit'] }))
    await store.add(draft({ title: 'second', tags: ['edit'] }))
    await store.add(draft({ title: 'third', tags: ['slowed'] }))
    resetWrites()

    await store.removeTag('slowed')

    expect(writeCount()).toBe(1)
    expect((await store.list()).map((song) => song.tags)).toEqual([['edit'], ['edit'], []])
    await expect(createLibraryStore(lib.root).list()).resolves.toMatchObject([
      { tags: ['edit'] },
      { tags: ['edit'] },
      { tags: [] }
    ])
  })

  it('writes nothing when no song carries the tag', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ tags: ['edit'] }))
    resetWrites()

    await store.removeTag('slowed')

    expect(writeCount()).toBe(0)
    expect(await store.list()).toEqual([added])
  })
})

describe('replaceFile', () => {
  it('repoints the song at a new file, persists, and hands back a copy', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ fileName: 'original.wav', compressed: false }))

    const replaced = await store.replaceFile(added.id, `${added.id}.opus`, true)

    expect(replaced).toEqual({ ...added, fileName: `${added.id}.opus`, compressed: true })
    await expect(createLibraryStore(lib.root).getSong(added.id)).resolves.toEqual(replaced)

    replaced.tags.push('injected')
    expect((await store.getSong(added.id))?.tags).toEqual(added.tags)
  })

  it('leaves every other field alone', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ title: 'Keep me', tags: ['keep'] }))
    await store.update(added.id, { durationSec: 90 })

    const replaced = await store.replaceFile(added.id, 'other.opus', true)

    expect(replaced).toMatchObject({ title: 'Keep me', tags: ['keep'], durationSec: 90 })
  })

  it('throws NotFound for an unknown id', async () => {
    const store = createLibraryStore(lib.root)

    await expect(store.replaceFile('missing', 'x.opus', true)).rejects.toBeInstanceOf(NotFoundError)
    await expect(store.replaceFile('missing', 'x.opus', true)).rejects.toMatchObject({
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

/**
 * The cache is process-lifetime: a store loads `library.json` once and never re-reads it. These
 * two tests pin that behaviour down, because it is what forces the composition root to hand ONE
 * store instance to every reader and mutator of a library directory — the importer behind
 * `library:add` included.
 */
describe('one instance per directory', () => {
  it('does not show a second instance the writes of the first', async () => {
    const first = createLibraryStore(lib.root)
    const second = createLibraryStore(lib.root)
    // Both instances take their snapshot before anything is written.
    expect(await first.list()).toEqual([])
    expect(await second.list()).toEqual([])

    const added = await first.add(draft({ title: 'written by the first instance' }))

    expect(await first.list()).toEqual([added])
    expect((await readLibraryFile(lib.root)).songs).toHaveLength(1)
    // The write reached the disk, but the second instance is stale for the rest of the session.
    expect(await second.list()).toEqual([])
    await expect(second.getSong(added.id)).resolves.toBeUndefined()
  })

  it('lets a stale second instance overwrite what the first instance wrote', async () => {
    const first = createLibraryStore(lib.root)
    const second = createLibraryStore(lib.root)
    await first.list()
    await second.list()

    await first.add(draft({ title: 'first' }))
    const fromSecond = await second.add(draft({ title: 'second' }))

    // The second instance persists its own snapshot, so the first instance's song is gone.
    expect((await readLibraryFile(lib.root)).songs).toEqual([fromSecond])
  })
})
