/**
 * `audi0z` paths on disk.
 *
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'

// Deliberately still the pre-rename folder: the app became Audi0z in v3.1, but every existing
// library lives under ~/Music/my-music-library and must keep working. Renaming this constant
// would strand them all.
export const LIBRARY_DIR_NAME = 'my-music-library'
export const LIBRARY_DIR_ENV_VAR = 'MML_LIBRARY_DIR'

export interface ResolveLibraryRootOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to Electron's `app.getPath('music')`, resolved lazily. */
  getMusicDir?: () => string
}

/** Lazy so that importing this module never pulls in Electron. */
function electronMusicDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('music')
}

/**
 * `MML_LIBRARY_DIR` wins over everything — that is how tests and e2e runs get an isolated
 * library. Otherwise the library sits in the user's music folder.
 */
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

/**
 * Creates the library root and its `audio/` directory. Synchronous on purpose: it runs once at
 * startup, before anything can read the stores, so there is nothing to gain from making every
 * caller await it.
 */
export function ensureDirs(root: string = resolveLibraryRoot()): void {
  mkdirSync(audioDir(root), { recursive: true })
}
