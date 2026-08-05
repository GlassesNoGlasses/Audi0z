import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Song } from '../../shared/types'
import type { LibraryStore } from '../store/storeTypes'
import { importFile } from './importer'

/** WP2 owns the real store; here it is a mock that records what the importer asked it to add. */
function mockLibraryStore(): LibraryStore {
  return {
    list: vi.fn(async () => []),
    getSong: vi.fn(async () => undefined),
    add: vi.fn(async (song: Song) => song),
    update: vi.fn(async () => {
      throw new Error('importer must not call update')
    }),
    updateDurations: vi.fn(async () => {
      throw new Error('importer must not call updateDurations')
    }),
    remove: vi.fn(async () => {
      throw new Error('importer must not call remove')
    }),
    renameTag: vi.fn(async () => {
      throw new Error('importer must not call renameTag')
    }),
    removeTag: vi.fn(async () => {
      throw new Error('importer must not call removeTag')
    }),
    replaceFile: vi.fn(async () => {
      throw new Error('importer must not call replaceFile')
    })
  }
}

describe('importFile', () => {
  let dir = ''
  let audioDir = ''
  let sourcePath = ''
  let libraryStore: LibraryStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mml-import-'))
    audioDir = path.join(dir, 'audio')
    await mkdir(audioDir)
    sourcePath = path.join(dir, 'Some Track.MP3')
    await writeFile(sourcePath, 'source bytes')
    libraryStore = mockLibraryStore()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('copies the source under a uuid file name and records one song when not compressing', async () => {
    const transcode = vi.fn(async () => {})

    const song = await importFile(
      { sourcePath, title: 'Some Track', tags: ['remix'], compress: false },
      { audioDir, libraryStore, transcode }
    )

    expect(transcode).not.toHaveBeenCalled()
    expect(song.fileName).toBe(`${song.id}.mp3`)
    expect(song.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(song.compressed).toBe(false)
    expect(song.title).toBe('Some Track')
    expect(song.tags).toEqual(['remix'])
    expect(Number.isNaN(Date.parse(song.addedAt))).toBe(false)
    expect(song.sourceUrl).toBeUndefined()

    expect(await readFile(path.join(audioDir, song.fileName), 'utf8')).toBe('source bytes')
    expect(await readdir(audioDir)).toEqual([song.fileName])
    expect(libraryStore.add).toHaveBeenCalledTimes(1)
    expect(vi.mocked(libraryStore.add).mock.calls[0][0]).toEqual(song)
    // The source is left alone unless the caller asks for it to go.
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('transcodes to .opus, records sourceUrl and deletes the source when asked', async () => {
    const transcode = vi.fn(async ({ dst }: { src: string; dst: string }) => {
      await writeFile(dst, 'opus bytes')
    })

    const song = await importFile(
      {
        sourcePath,
        title: 'Some Track',
        tags: [],
        compress: true,
        sourceUrl: 'https://example.test/v/1',
        deleteSource: true
      },
      { audioDir, libraryStore, transcode }
    )

    expect(transcode).toHaveBeenCalledWith({
      src: sourcePath,
      dst: path.join(audioDir, `${song.id}.opus.staged`)
    })
    expect(song.fileName).toBe(`${song.id}.opus`)
    expect(song.compressed).toBe(true)
    expect(song.sourceUrl).toBe('https://example.test/v/1')
    expect(existsSync(sourcePath)).toBe(false)
    expect(await readdir(audioDir)).toEqual([song.fileName])
    expect(libraryStore.add).toHaveBeenCalledTimes(1)
  })

  /**
   * Opus is not guaranteed to win: a lean lossy source can re-encode to the same size or bigger,
   * and an equal-sized re-encode is all cost and no gain, so the comparison is `<`, not `<=`. The
   * import still has to land a song, so it falls back to the plain copy it would have made with
   * compression switched off — and records the song as uncompressed, which is what it is.
   */
  it('falls back to a plain copy when the opus re-encode is not smaller', async () => {
    const { size } = await stat(sourcePath)
    const transcode = vi.fn(async ({ dst }: { src: string; dst: string }) => {
      await writeFile(dst, 'x'.repeat(size))
    })

    const song = await importFile(
      { sourcePath, title: 'Some Track', tags: [], compress: true },
      { audioDir, libraryStore, transcode }
    )

    expect(transcode).toHaveBeenCalledWith({
      src: sourcePath,
      dst: path.join(audioDir, `${song.id}.opus.staged`)
    })
    expect(song.compressed).toBe(false)
    expect(song.fileName).toBe(`${song.id}.mp3`)
    // The staged opus is gone, and what landed is the source byte for byte.
    expect(await readdir(audioDir)).toEqual([song.fileName])
    expect(await readFile(path.join(audioDir, song.fileName), 'utf8')).toBe('source bytes')
    expect(vi.mocked(libraryStore.add).mock.calls[0][0]).toEqual(song)
  })

  /** The staged opus is residue too: a failure after it is written must not leave it behind. */
  it('leaves no staged opus behind when the store rejects a compressed import', async () => {
    vi.mocked(libraryStore.add).mockRejectedValueOnce(new Error('library.json is locked'))
    const transcode = vi.fn(async ({ dst }: { src: string; dst: string }) => {
      await writeFile(dst, 'opus')
    })

    await expect(
      importFile(
        { sourcePath, title: 'Some Track', tags: [], compress: true },
        { audioDir, libraryStore, transcode }
      )
    ).rejects.toThrow(/library.json is locked/)

    expect(await readdir(audioDir)).toEqual([])
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('adds nothing and leaves no residue when the transcode fails', async () => {
    const transcode = vi.fn(async ({ dst }: { src: string; dst: string }) => {
      await writeFile(dst, 'half a file')
      throw new Error('ffmpeg exited with code 1')
    })

    await expect(
      importFile(
        { sourcePath, title: 'Some Track', tags: [], compress: true, deleteSource: true },
        { audioDir, libraryStore, transcode }
      )
    ).rejects.toThrow(/ffmpeg exited with code 1/)

    expect(libraryStore.add).not.toHaveBeenCalled()
    expect(await readdir(audioDir)).toEqual([])
    // A failed import must not destroy the user's source file.
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('removes the copied file when the store rejects', async () => {
    vi.mocked(libraryStore.add).mockRejectedValueOnce(new Error('library.json is locked'))

    await expect(
      importFile(
        { sourcePath, title: 'Some Track', tags: [], compress: false },
        { audioDir, libraryStore, transcode: vi.fn(async () => {}) }
      )
    ).rejects.toThrow(/library.json is locked/)

    expect(await readdir(audioDir)).toEqual([])
  })

  it('throws before touching the store when the source does not exist', async () => {
    const transcode = vi.fn(async () => {})

    await expect(
      importFile(
        { sourcePath: path.join(dir, 'missing.mp3'), title: 'Gone', tags: [], compress: false },
        { audioDir, libraryStore, transcode }
      )
    ).rejects.toThrow(/missing\.mp3/)

    expect(libraryStore.add).not.toHaveBeenCalled()
    expect(transcode).not.toHaveBeenCalled()
    expect(await readdir(audioDir)).toEqual([])
  })
})
