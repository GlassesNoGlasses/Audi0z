import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  audioDir,
  ensureDirs,
  libraryJsonPath,
  playlistsJsonPath,
  resolveLibraryRoot,
  settingsJsonPath,
  tagsJsonPath
} from './paths'

const MUSIC_DIR = path.join(path.sep, 'Users', 'tester', 'Music')
const getMusicDir = (): string => MUSIC_DIR

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveLibraryRoot', () => {
  it('honours AUDI0Z_LIBRARY_DIR above everything else', () => {
    const override = path.join(path.sep, 'tmp', 'isolated-library')
    expect(resolveLibraryRoot({ env: { AUDI0Z_LIBRARY_DIR: override }, getMusicDir })).toBe(override)
  })

  it('reads AUDI0Z_LIBRARY_DIR from process.env when no env is passed', () => {
    const override = path.join(path.sep, 'tmp', 'from-process-env')
    vi.stubEnv('AUDI0Z_LIBRARY_DIR', override)
    expect(resolveLibraryRoot({ getMusicDir })).toBe(override)
  })

  it('defaults to <music>/audi0z', () => {
    expect(resolveLibraryRoot({ env: {}, getMusicDir })).toBe(
      path.join(MUSIC_DIR, 'audi0z')
    )
  })

  it('ignores an empty AUDI0Z_LIBRARY_DIR', () => {
    expect(resolveLibraryRoot({ env: { AUDI0Z_LIBRARY_DIR: '   ' }, getMusicDir })).toBe(
      path.join(MUSIC_DIR, 'audi0z')
    )
  })

  it('resolves a relative AUDI0Z_LIBRARY_DIR to an absolute path', () => {
    const root = resolveLibraryRoot({ env: { AUDI0Z_LIBRARY_DIR: 'relative-library' }, getMusicDir })
    expect(path.isAbsolute(root)).toBe(true)
    expect(path.basename(root)).toBe('relative-library')
  })
})

describe('library file paths', () => {
  const root = path.join(path.sep, 'tmp', 'lib')

  it('places the json stores and the audio directory under the root', () => {
    expect(libraryJsonPath(root)).toBe(path.join(root, 'library.json'))
    expect(playlistsJsonPath(root)).toBe(path.join(root, 'playlists.json'))
    expect(settingsJsonPath(root)).toBe(path.join(root, 'settings.json'))
    expect(tagsJsonPath(root)).toBe(path.join(root, 'tags.json'))
    expect(audioDir(root)).toBe(path.join(root, 'audio'))
  })
})

describe('ensureDirs', () => {
  const created: string[] = []

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function freshRoot(): string {
    const base = mkdtempSync(path.join(os.tmpdir(), 'mml-paths-'))
    created.push(base)
    return path.join(base, 'library-root')
  }

  it('creates the library root and the audio directory', () => {
    const root = freshRoot()
    ensureDirs(root)
    expect(statSync(root).isDirectory()).toBe(true)
    expect(statSync(audioDir(root)).isDirectory()).toBe(true)
  })

  it('is idempotent', () => {
    const root = freshRoot()
    ensureDirs(root)
    ensureDirs(root)
    expect(existsSync(audioDir(root))).toBe(true)
  })
})
