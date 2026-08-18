import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const LIBRARY_DIR_NAME = 'audi0z'
export const LIBRARY_DIR_ENV_VAR = 'AUDI0Z_LIBRARY_DIR'

export interface ResolveLibraryRootOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to Electron's `app.getPath('music')`, resolved lazily. */
  getMusicDir?: () => string
}

/** Lazy so that importing this module never pulls in Electron when not needed */
function electronMusicDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('music')
}

/** If set, ENV var `AUDI0Z_LIBRARY_DIR` is the main root dir. Else we use `~/Music`. */
export function resolveLibraryRoot(options: ResolveLibraryRootOptions = {}): string {
  const env = options.env ?? process.env
  const override = env[LIBRARY_DIR_ENV_VAR]
  if (override && override.trim() !== '') {
    return path.resolve(override.trim())
  }
  const getMusicDir = options.getMusicDir ?? electronMusicDir
  return path.join(getMusicDir(), LIBRARY_DIR_NAME)
}

export function libraryJsonPath(root: string = resolveLibraryRoot()): string {
  return path.join(root, 'library.json')
}

export function playlistsJsonPath(root: string = resolveLibraryRoot()): string {
  return path.join(root, 'playlists.json')
}

export function settingsJsonPath(root: string = resolveLibraryRoot()): string {
  return path.join(root, 'settings.json')
}

export function tagsJsonPath(root: string = resolveLibraryRoot()): string {
  return path.join(root, 'tags.json')
}

export function audioDir(root: string = resolveLibraryRoot()): string {
  return path.join(root, 'audio')
}

/** Creates the library root and its `audio/` directory. */
export function ensureDirs(root: string = resolveLibraryRoot()): void {
  mkdirSync(audioDir(root), { recursive: true })
}
