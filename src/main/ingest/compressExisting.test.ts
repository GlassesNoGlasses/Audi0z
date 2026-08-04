import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import type { Song } from '../../shared/types'
import { NotFoundError } from '../store/errors'
import { createLibraryStore } from '../store/libraryStore'
import type { LibraryStore } from '../store/storeTypes'
import { compressExisting } from './compressExisting'

let lib: TmpLibrary
let libraryStore: LibraryStore

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

/** Adds a song and writes the bytes its `fileName` points at. */
async function addSongWithFile(overrides: Partial<Song> = {}): Promise<Song> {
  const song = await libraryStore.add(draft(overrides))
  await writeFile(path.join(lib.audio, song.fileName), `bytes of ${song.fileName}`)
  return song
}

type Transcode = (opts: { src: string; dst: string }) => Promise<void>

/** A transcode that actually produces an output file, the way ffmpeg would. */
function fakeTranscode(): ReturnType<typeof vi.fn<Transcode>> {
  return vi.fn<Transcode>(async ({ dst }) => {
    await writeFile(dst, 'opus bytes')
  })
}

beforeEach(async () => {
  lib = await createTmpLibrary()
  libraryStore = createLibraryStore(lib.root)
})

afterEach(async () => {
  await lib.cleanup()
})

describe('compressExisting', () => {
  it('transcodes to <id>.opus, records the swap and deletes the old file', async () => {
    const song = await addSongWithFile({ fileName: 'original.wav' })
    const transcode = fakeTranscode()

    const compressed = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    expect(transcode).toHaveBeenCalledExactlyOnceWith({
      src: path.join(lib.audio, 'original.wav'),
      dst: path.join(lib.audio, `${song.id}.opus`)
    })
    expect(compressed).toEqual({ ...song, fileName: `${song.id}.opus`, compressed: true })
    await expect(libraryStore.getSong(song.id)).resolves.toEqual(compressed)
    expect(await readdir(lib.audio)).toEqual([`${song.id}.opus`])
  })

  /**
   * `transcode` stages through `<dst>.part` and renames, so an uncompressed `.opus` source whose
   * name already matches the target is an in-place atomic replace — and deleting "the old file"
   * afterwards would delete the file that was just written.
   */
  it('replaces an uncompressed .opus in place without deleting anything', async () => {
    const id = 'already-named'
    const song = await addSongWithFile({ id, fileName: `${id}.opus` })
    const transcode = fakeTranscode()

    const compressed = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    const dst = path.join(lib.audio, `${id}.opus`)
    expect(transcode).toHaveBeenCalledExactlyOnceWith({ src: dst, dst })
    expect(compressed.compressed).toBe(true)
    expect(compressed.fileName).toBe(`${id}.opus`)
    expect(existsSync(dst)).toBe(true)
    expect(await readFile(dst, 'utf8')).toBe('opus bytes')
  })

  it('throws NotFound for an unknown id without transcoding', async () => {
    const transcode = fakeTranscode()

    await expect(
      compressExisting('missing', { audioDir: lib.audio, libraryStore, transcode })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(transcode).not.toHaveBeenCalled()
  })

  it('refuses a song that is already compressed, by name and by title', async () => {
    const song = await addSongWithFile({ title: 'Nightdrive', compressed: true })
    const transcode = fakeTranscode()

    const failure = compressExisting(song.id, { audioDir: lib.audio, libraryStore, transcode })

    await expect(failure).rejects.toThrow('Song "Nightdrive" is already compressed')
    await expect(failure).rejects.toMatchObject({ name: 'AlreadyCompressed' })
    expect(transcode).not.toHaveBeenCalled()
  })

  it('refuses a fileName that resolves outside the audio directory', async () => {
    const song = await libraryStore.add(draft({ fileName: path.join('..', '..', 'etc', 'passwd') }))
    const transcode = fakeTranscode()

    await expect(
      compressExisting(song.id, { audioDir: lib.audio, libraryStore, transcode })
    ).rejects.toThrow()
    expect(transcode).not.toHaveBeenCalled()
    await expect(libraryStore.getSong(song.id)).resolves.toEqual(song)
  })

  it('refuses when the source file is not on disk', async () => {
    const song = await libraryStore.add(draft({ fileName: 'ghost.wav' }))
    const transcode = fakeTranscode()

    await expect(
      compressExisting(song.id, { audioDir: lib.audio, libraryStore, transcode })
    ).rejects.toThrow(/source file not found/)
    expect(transcode).not.toHaveBeenCalled()
    await expect(libraryStore.getSong(song.id)).resolves.toEqual(song)
  })

  /** Ordering: the library row only moves once the new file is actually there. */
  it('leaves the record untouched and deletes nothing when the transcode fails', async () => {
    const song = await addSongWithFile({ fileName: 'original.wav' })
    const transcode = vi.fn<Transcode>(async () => {
      throw new Error('ffmpeg exited with code 1')
    })

    await expect(
      compressExisting(song.id, { audioDir: lib.audio, libraryStore, transcode })
    ).rejects.toThrow('ffmpeg exited with code 1')

    await expect(libraryStore.getSong(song.id)).resolves.toEqual(song)
    expect(await readdir(lib.audio)).toEqual(['original.wav'])
  })

  it('still succeeds when the old file refuses to go', async () => {
    const song = await addSongWithFile({ fileName: 'original.wav' })
    const transcode = fakeTranscode()
    const fs = {
      access: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      rm: vi.fn(async () => {
        throw new Error('EBUSY')
      })
    }

    const compressed = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode,
      fs
    })

    expect(compressed.compressed).toBe(true)
    expect(fs.rm).toHaveBeenCalledWith(path.join(lib.audio, 'original.wav'), { force: true })
  })
})
