import type { Settings } from '../../shared/types'
import { settingsJsonPath } from '../paths'
import { readJsonFile, writeJsonFile } from './jsonFile'
import type { CreateSettingsStore } from './storeTypes'

/**
 * `settings.json` behind the `SettingsStore` interface.
 *
 * Tiny and total: every field has a default, so a missing or unreadable file is never an error —
 * the app just starts with the documented defaults.
 */

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  compressByDefault: false,
  volume: 1,
  libraryShuffle: false,
  libraryRepeat: false
}

const makeDefaults = (): Settings => ({ ...DEFAULT_SETTINGS })

function isSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null) return false
  const settings = value as Partial<Settings>
  return (
    settings.version === 1 &&
    typeof settings.compressByDefault === 'boolean' &&
    typeof settings.volume === 'number' &&
    Number.isFinite(settings.volume) &&
    typeof settings.libraryShuffle === 'boolean' &&
    typeof settings.libraryRepeat === 'boolean'
  )
}

/** Merges known keys only, so a stray property from the renderer never reaches the disk. */
function merge(current: Settings, patch: Partial<Settings>): Settings {
  return {
    version: 1,
    compressByDefault: patch.compressByDefault ?? current.compressByDefault,
    volume: patch.volume ?? current.volume,
    libraryShuffle: patch.libraryShuffle ?? current.libraryShuffle,
    libraryRepeat: patch.libraryRepeat ?? current.libraryRepeat
  }
}

export const createSettingsStore: CreateSettingsStore = (dir) => {
  const filePath = settingsJsonPath(dir)
  let settings: Settings | null = null
  let loading: Promise<Settings> | null = null

  async function load(): Promise<Settings> {
    if (settings !== null) return settings
    if (loading === null) {
      loading = readJsonFile(filePath, isSettings, makeDefaults)
      void loading.catch(() => {
        loading = null
      })
    }
    const loaded = await loading
    if (settings === null) settings = loaded
    return settings
  }

  return {
    async get() {
      return { ...(await load()) }
    },

    async set(patch) {
      const next = merge(await load(), patch)
      settings = next
      await writeJsonFile(filePath, next)
      return { ...next }
    }
  }
}
