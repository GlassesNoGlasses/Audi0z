import type { Settings } from '../../shared/types'
import { settingsJsonPath } from '../paths'
import { loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreateSettingsStore } from './storeTypes'

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

function update(current: Settings, patch: Partial<Settings>): Settings {
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
  const load = loadOnce(() => readJsonFile(filePath, isSettings, makeDefaults))

  return {
    async get() {
      return { ...(await load()) }
    },

    async set(patch) {
      const current = await load()
      Object.assign(current, update(current, patch))
      await writeJsonFile(filePath, current)
      return { ...current }
    }
  }
}
