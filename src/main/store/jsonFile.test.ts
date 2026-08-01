import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import {
  RENAME_RETRY_DELAY_MS,
  loadOnce,
  readJsonFile,
  renameWithRetry,
  writeJsonFile
} from './jsonFile'

interface Doc {
  version: 1
  items: string[]
}

function isDoc(value: unknown): value is Doc {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const doc = value as Partial<Doc>
  return doc.version === 1 && Array.isArray(doc.items)
}

const makeDefault = (): Doc => ({ version: 1, items: [] })

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`fake ${code}`)
  err.code = code
  return err
}

let lib: TmpLibrary
let file: string

beforeEach(async () => {
  lib = await createTmpLibrary()
  file = path.join(lib.root, 'doc.json')
})

afterEach(async () => {
  await lib.cleanup()
})

describe('readJsonFile', () => {
  it('returns the default for a missing file without creating anything', async () => {
    const before = (await readdir(lib.root)).sort()

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({ version: 1, items: [] })

    expect((await readdir(lib.root)).sort()).toEqual(before)
  })

  it('parses a valid file', async () => {
    await writeFile(file, JSON.stringify({ version: 1, items: ['a', 'b'] }), 'utf8')

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({
      version: 1,
      items: ['a', 'b']
    })
  })

  it('quarantines malformed JSON to <file>.bak and returns the default', async () => {
    const raw = '{ "version": 1, "items": [ '
    await writeFile(file, raw, 'utf8')

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({ version: 1, items: [] })

    expect(await readFile(`${file}.bak`, 'utf8')).toBe(raw)
  })

  it.each([
    ['a top-level array', '[1, 2, 3]'],
    ['the wrong version', '{ "version": 2, "items": [] }'],
    ['a missing collection', '{ "version": 1 }']
  ])('quarantines structurally wrong JSON (%s)', async (_label, raw) => {
    await writeFile(file, raw, 'utf8')

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({ version: 1, items: [] })

    expect(await readFile(`${file}.bak`, 'utf8')).toBe(raw)
  })

  it('leaves the unreadable original in place next to the backup', async () => {
    await writeFile(file, 'not json', 'utf8')

    await readJsonFile(file, isDoc, makeDefault)

    expect(await readFile(file, 'utf8')).toBe('not json')
  })
})

describe('writeJsonFile', () => {
  it('writes JSON that reads back through readJsonFile', async () => {
    await writeJsonFile(file, { version: 1, items: ['x'] })

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({
      version: 1,
      items: ['x']
    })
  })

  it('leaves no .tmp-* residue behind', async () => {
    await writeJsonFile(file, { version: 1, items: ['one'] })
    await writeJsonFile(file, { version: 1, items: ['two'] })
    await writeJsonFile(file, { version: 1, items: ['three'] })

    const entries = await readdir(lib.root)
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(entries).toContain('doc.json')
  })

  it('serialises concurrent writes to the same path: never torn, last write wins', async () => {
    await writeJsonFile(file, { version: 1, items: ['seed'] })

    const writes = Array.from({ length: 20 }, (_unused, index) =>
      writeJsonFile(file, { version: 1, items: [`write-${index}`] })
    )
    const reads = Array.from({ length: 50 }, async () => {
      const raw = await readFile(file, 'utf8')
      return JSON.parse(raw) as unknown
    })

    const observed = await Promise.all(reads)
    await Promise.all(writes)

    for (const value of observed) expect(isDoc(value)).toBe(true)
    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({
      version: 1,
      items: ['write-19']
    })
  })

  it('keeps concurrent writes to different paths independent', async () => {
    const other = path.join(lib.root, 'other.json')

    await Promise.all([
      writeJsonFile(file, { version: 1, items: ['a'] }),
      writeJsonFile(other, { version: 1, items: ['b'] })
    ])

    await expect(readJsonFile(file, isDoc, makeDefault)).resolves.toEqual({
      version: 1,
      items: ['a']
    })
    await expect(readJsonFile(other, isDoc, makeDefault)).resolves.toEqual({
      version: 1,
      items: ['b']
    })
  })

  it('cleans up the temp file when the write fails', async () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    await expect(writeJsonFile(file, circular)).rejects.toThrow()

    expect((await readdir(lib.root)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})

describe('loadOnce', () => {
  it('reads once however many times it is called', async () => {
    const read = vi.fn(async () => ['value'])
    const load = loadOnce(read)

    expect(await load()).toEqual(['value'])
    expect(await load()).toEqual(['value'])

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('shares a single read between concurrent callers', async () => {
    const read = vi.fn(async () => ({ loaded: true }))
    const load = loadOnce(read)

    const [first, second] = await Promise.all([load(), load()])

    expect(read).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('does not cache a failed read', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValueOnce('second try')
    const load = loadOnce(read)

    await expect(load()).rejects.toThrow('disk gone')
    await expect(load()).resolves.toBe('second try')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('renameWithRetry', () => {
  it('retries once after EPERM and then succeeds', async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(errno('EPERM'))
      .mockResolvedValueOnce(undefined)
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    await renameWithRetry('from', 'to', { rename, delay })

    expect(rename).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(RENAME_RETRY_DELAY_MS)
  })

  it('gives up after a second EPERM', async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errno('EPERM'))
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    await expect(renameWithRetry('from', 'to', { rename, delay })).rejects.toMatchObject({
      code: 'EPERM'
    })
    expect(rename).toHaveBeenCalledTimes(2)
  })

  it('does not retry other errors', async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errno('ENOENT'))
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    await expect(renameWithRetry('from', 'to', { rename, delay })).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })
})
