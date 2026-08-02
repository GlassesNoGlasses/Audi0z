import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import { settingsJsonPath } from '../paths'
import type { Settings } from '../../shared/types'
import { createSettingsStore } from './settingsStore'

const DEFAULTS: Settings = {
  version: 1,
  compressByDefault: false,
  volume: 1,
  libraryShuffle: false,
  libraryRepeat: false
}

let lib: TmpLibrary

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

describe('get', () => {
  it('returns the documented defaults when there is no settings.json', async () => {
    await expect(createSettingsStore(lib.root).get()).resolves.toEqual(DEFAULTS)
  })

  it('falls back to the defaults and quarantines a corrupt settings.json', async () => {
    await writeFile(settingsJsonPath(lib.root), '{ "volume": ', 'utf8')

    await expect(createSettingsStore(lib.root).get()).resolves.toEqual(DEFAULTS)
    expect(await readFile(`${settingsJsonPath(lib.root)}.bak`, 'utf8')).toBe('{ "volume": ')
  })

  it('falls back to the defaults when a field has the wrong type', async () => {
    await writeFile(
      settingsJsonPath(lib.root),
      JSON.stringify({ ...DEFAULTS, volume: 'loud' }),
      'utf8'
    )

    await expect(createSettingsStore(lib.root).get()).resolves.toEqual(DEFAULTS)
  })
})

describe('set', () => {
  it('merges a partial patch and persists it', async () => {
    const store = createSettingsStore(lib.root)

    const afterVolume = await store.set({ volume: 0.25 })
    expect(afterVolume).toEqual({ ...DEFAULTS, volume: 0.25 })

    const afterCompress = await store.set({ compressByDefault: true })
    expect(afterCompress).toEqual({ ...DEFAULTS, volume: 0.25, compressByDefault: true })

    await expect(createSettingsStore(lib.root).get()).resolves.toEqual({
      ...DEFAULTS,
      volume: 0.25,
      compressByDefault: true
    })
  })

  it('sets the library shuffle and repeat flags independently', async () => {
    const store = createSettingsStore(lib.root)

    await store.set({ libraryShuffle: true })
    const both = await store.set({ libraryRepeat: true })

    expect(both.libraryShuffle).toBe(true)
    expect(both.libraryRepeat).toBe(true)
  })

  it('ignores unknown keys instead of persisting junk', async () => {
    const store = createSettingsStore(lib.root)

    await store.set({ volume: 0.5, nonsense: true } as Partial<Settings>)

    const raw = JSON.parse(await readFile(settingsJsonPath(lib.root), 'utf8')) as Settings
    expect(raw).toEqual({ ...DEFAULTS, volume: 0.5 })
  })

  it('keeps an empty patch a no-op', async () => {
    const store = createSettingsStore(lib.root)

    await expect(store.set({})).resolves.toEqual(DEFAULTS)
  })
})
