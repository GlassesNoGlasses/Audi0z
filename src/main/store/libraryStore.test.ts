import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { libraryJsonPath } from '../paths'
import type { LibraryFile, Song } from '../../shared/types'
import { ConflictError, NotFoundError } from './errors'
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

describe('updateDurations', () => {
  it('writes every measured duration in one pass and skips ids that are gone', async () => {
    const store = createLibraryStore(lib.root)
    const a = await store.add(draft({ title: 'A', fileName: 'a.wav', tags: [] }))
    const b = await store.add(draft({ title: 'B', fileName: 'b.wav', tags: [] }))
    resetWrites()

    const updated = await store.updateDurations([
      { id: a.id, durationSec: 173 },
      { id: b.id, durationSec: 41 },
      { id: 'ghost', durationSec: 9 }
    ])

    expect(writeCount()).toBe(1)
    expect(updated.map((s) => [s.id, s.durationSec])).toEqual([
      [a.id, 173],
      [b.id, 41]
    ])
    const all = await store.list()
    expect(all.find((s) => s.id === a.id)?.durationSec).toBe(173)
    expect(all.find((s) => s.id === b.id)?.durationSec).toBe(41)
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([
      { ...a, durationSec: 173 },
      { ...b, durationSec: 41 }
    ])
  })

  it('does not touch the file when nothing matched', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft())
    resetWrites()

    await expect(store.updateDurations([{ id: 'ghost', durationSec: 9 }])).resolves.toEqual([])

    expect(writeCount()).toBe(0)
    expect(await store.list()).toEqual([added])
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

  /**
   * The registry lets a tag be "renamed" to the name it already has (the rename dialog's confirm
   * button does not care that nothing changed), and the IPC layer cascades unconditionally. The
   * merge branch must not read that as "this song already has the new name, so drop the old one" —
   * that would wipe the tag off every song carrying it.
   */
  it('is a no-op when the new name is identical to the old one', async () => {
    const store = createLibraryStore(lib.root)
    const first = await store.add(draft({ title: 'first', tags: ['slowed', 'edit'] }))
    const second = await store.add(draft({ title: 'second', tags: ['slowed'] }))
    resetWrites()

    await store.renameTag('slowed', 'slowed')

    expect(writeCount()).toBe(0)
    expect((await store.list()).map((song) => song.tags)).toEqual([['slowed', 'edit'], ['slowed']])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([first, second])
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

/**
 * Not the crash case — a crash takes the cache with it. This is the write that *rejects* (ENOSPC,
 * EIO) in a process that carries on: a cache holding contents the file does not have would be
 * flushed out whole by the next unrelated write, silently committing half a tag cascade nobody
 * asked for. So the two cascade passes build into a copy and only adopt it once the disk has it.
 */
describe('a cascade whose write is refused', () => {
  function enospc(): Error {
    return Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
  }

  it('leaves renameTag reading back what is actually on disk', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ tags: ['slowed', 'edit'] }))
    vi.mocked(writeJsonFile).mockRejectedValueOnce(enospc())

    await expect(store.renameTag('slowed', 'slow')).rejects.toThrow('no space left on device')

    expect(await store.list()).toEqual([added])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([added])
  })

  it('leaves removeTag reading back what is actually on disk', async () => {
    const store = createLibraryStore(lib.root)
    const added = await store.add(draft({ tags: ['slowed', 'edit'] }))
    vi.mocked(writeJsonFile).mockRejectedValueOnce(enospc())

    await expect(store.removeTag('slowed')).rejects.toThrow('no space left on device')

    expect(await store.list()).toEqual([added])
    await expect(createLibraryStore(lib.root).list()).resolves.toEqual([added])
  })
})

/**
 * `persist` is an await, and nothing serialises the store's methods against each other — an import
 * or the startup duration backfill can land in the cache while a cascade's write is still in the
 * air. Adoption is therefore the same per-song rewrite applied in place, never a swap for the
 * snapshot the cascade set out with: that would erase whatever arrived in the meantime from the
 * cache, and then from disk, since the next write stringifies the cache as it finds it.
 */
describe('a cascade whose write is still in flight', () => {
  /** Parks the next `writeJsonFile` call until it is released, and says when it got there. */
  function parkNextWrite(): { started: Promise<void>; release: () => void } {
    let announce!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      announce = resolve
    })
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(writeJsonFile).mockImplementationOnce(() => {
      announce()
      return parked
    })
    return { started, release }
  }

  it('keeps a song added while the renameTag write is in flight', async () => {
    const store = createLibraryStore(lib.root)
    const first = await store.add(draft({ title: 'first', tags: ['slowed'] }))
    const write = parkNextWrite()

    const renaming = store.renameTag('slowed', 'slow')
    await write.started
    const added = await store.add(draft({ title: 'arrived mid-write', tags: [] }))
    write.release()
    await renaming

    expect(await store.list()).toEqual([{ ...first, tags: ['slow'] }, added])
  })

  it('keeps a song added while the removeTag write is in flight', async () => {
    const store = createLibraryStore(lib.root)
    const first = await store.add(draft({ title: 'first', tags: ['slowed', 'edit'] }))
    const write = parkNextWrite()

    const removing = store.removeTag('slowed')
    await write.started
    const added = await store.add(draft({ title: 'arrived mid-write', tags: [] }))
    write.release()
    await removing

    expect(await store.list()).toEqual([{ ...first, tags: ['edit'] }, added])
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
    const added = await store.add(draft({ title: 'Keep me', tags: ['keep'], durationSec: 90 }))

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

describe('reorder', () => {
  it('applies and persists the new library order', async () => {
    const store = createLibraryStore(lib.root)
    const a = await store.add(draft({ title: 'a' }))
    const b = await store.add(draft({ title: 'b' }))
    const c = await store.add(draft({ title: 'c' }))

    await store.reorder([c.id, a.id, b.id])

    expect((await store.list()).map((song) => song.title)).toEqual(['c', 'a', 'b'])
    // A second store over the same dir reads the same order back off disk.
    expect((await createLibraryStore(lib.root).list()).map((song) => song.title)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('rejects an order that does not name every song exactly once', async () => {
    const store = createLibraryStore(lib.root)
    const a = await store.add(draft({ title: 'a' }))
    const b = await store.add(draft({ title: 'b' }))

    await expect(store.reorder([a.id])).rejects.toBeInstanceOf(ConflictError)
    // The duplicate covers every name, so only the length gives it away.
    await expect(store.reorder([a.id, a.id, b.id])).rejects.toBeInstanceOf(ConflictError)
    await expect(store.reorder([a.id, 'nope'])).rejects.toBeInstanceOf(NotFoundError)

    // A failed reorder leaves the order alone.
    expect((await store.list()).map((song) => song.id)).toEqual([a.id, b.id])
  })

  it('a failed persist leaves the cached order alone', async () => {
    const store = createLibraryStore(lib.root)
    const a = await store.add(draft({ title: 'a' }))
    const b = await store.add(draft({ title: 'b' }))

    vi.mocked(writeJsonFile).mockRejectedValueOnce(new Error('disk full'))
    await expect(store.reorder([b.id, a.id])).rejects.toThrow('disk full')

    expect((await store.list()).map((song) => song.id)).toEqual([a.id, b.id])
    // The next successful write must not smuggle the failed order onto disk behind it.
    await store.update(a.id, { title: 'a2' })
    expect((await createLibraryStore(lib.root).list()).map((song) => song.id)).toEqual([a.id, b.id])
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
