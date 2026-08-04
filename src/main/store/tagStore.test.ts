import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import type { TagsFile } from '../../shared/types'
import { tagsJsonPath } from '../paths'
import { ConflictError, NotFoundError } from './errors'
import { createTagStore } from './tagStore'

let lib: TmpLibrary

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

describe('createTagStore', () => {
  it('starts empty when there is no tags.json', async () => {
    await expect(createTagStore(lib.root).list()).resolves.toEqual([])
  })

  it('falls back to an empty registry when tags.json is corrupt', async () => {
    await writeFile(tagsJsonPath(lib.root), '{ not json', 'utf8')

    await expect(createTagStore(lib.root).list()).resolves.toEqual([])
  })
})

describe('create', () => {
  it('assigns a uuid and persists a versioned file', async () => {
    const created = await createTagStore(lib.root).create('slowed')

    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(created.name).toBe('slowed')

    const file = JSON.parse(await readFile(tagsJsonPath(lib.root), 'utf8')) as TagsFile
    expect(file.version).toBe(1)
    await expect(createTagStore(lib.root).list()).resolves.toEqual([created])
  })

  it('trims the name', async () => {
    const created = await createTagStore(lib.root).create('  reverb\t')

    expect(created.name).toBe('reverb')
  })

  it.each([[''], ['   '], ['\t\n']])('refuses an empty name (%j)', async (name) => {
    const store = createTagStore(lib.root)

    await expect(store.create(name)).rejects.toThrow()
    expect(await store.list()).toEqual([])
  })

  it('refuses a duplicate name whatever its case, naming the tag that is in the way', async () => {
    const store = createTagStore(lib.root)
    await store.create('Slowed')

    await expect(store.create('slowed')).rejects.toBeInstanceOf(ConflictError)
    await expect(store.create('  SLOWED ')).rejects.toThrow('A tag named "Slowed" already exists')
    expect(await store.list()).toHaveLength(1)
  })

  /**
   * `hue = floor(rng() * 360)`, then HSL(hue, 65%, 55%) as `#rrggbb`. The expectations come from
   * the CSS Color 4 conversion, computed independently of the implementation.
   */
  it.each([
    [0, 0, '#d74242'],
    [0.25, 90, '#8cd742'],
    [0.5, 180, '#42d7d7'],
    [0.75, 270, '#8c42d7'],
    [0.9999, 359, '#d74244']
  ])('turns rng %s (hue %s) into %s', async (n, _hue, hex) => {
    const created = await createTagStore(lib.root, () => n).create('coloured')

    expect(created.color).toBe(hex)
  })

  it('defaults to a random colour that is still a well-formed hex triple', async () => {
    const created = await createTagStore(lib.root).create('random')

    expect(created.color).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('rename', () => {
  it('renames, trims and persists', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('old')

    const renamed = await store.rename(created.id, '  new  ')

    expect(renamed).toEqual({ ...created, name: 'new' })
    await expect(createTagStore(lib.root).list()).resolves.toEqual([renamed])
  })

  it('lets a tag re-case its own name', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('slowed')

    await expect(store.rename(created.id, 'Slowed')).resolves.toMatchObject({ name: 'Slowed' })
  })

  it('refuses a name another tag already holds', async () => {
    const store = createTagStore(lib.root)
    await store.create('slowed')
    const other = await store.create('reverb')

    await expect(store.rename(other.id, 'SLOWED')).rejects.toBeInstanceOf(ConflictError)
    expect((await store.list()).map((t) => t.name)).toEqual(['slowed', 'reverb'])
  })

  it('refuses an empty name', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('slowed')

    await expect(store.rename(created.id, '   ')).rejects.toThrow()
  })

  it('throws NotFound for an unknown id', async () => {
    const store = createTagStore(lib.root)

    await expect(store.rename('missing', 'x')).rejects.toBeInstanceOf(NotFoundError)
    await expect(store.rename('missing', 'x')).rejects.toMatchObject({ name: 'NotFound' })
  })
})

describe('remove', () => {
  it('drops the tag and persists', async () => {
    const store = createTagStore(lib.root)
    const first = await store.create('a')
    const second = await store.create('b')

    await store.remove(first.id)

    expect(await store.list()).toEqual([second])
    await expect(createTagStore(lib.root).list()).resolves.toEqual([second])
  })

  it('is a no-op for an unknown id', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('a')

    await expect(store.remove('missing')).resolves.toBeUndefined()
    expect(await store.list()).toEqual([created])
  })

  it('frees the name for re-use', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('slowed')
    await store.remove(created.id)

    await expect(store.create('slowed')).resolves.toMatchObject({ name: 'slowed' })
  })
})

describe('getTag', () => {
  it('returns the tag and undefined for an unknown id', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('slowed')

    await expect(store.getTag(created.id)).resolves.toEqual(created)
    await expect(store.getTag('nope')).resolves.toBeUndefined()
  })
})

describe('cache isolation', () => {
  it('does not let callers mutate the store through returned tags', async () => {
    const store = createTagStore(lib.root)
    const created = await store.create('slowed')

    const listed = await store.list()
    listed[0].name = 'injected'
    listed.pop()
    const fetched = await store.getTag(created.id)
    if (fetched) fetched.color = '#000000'

    expect(await store.list()).toEqual([created])
  })
})
