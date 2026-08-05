import { existsSync } from 'node:fs'
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
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

/**
 * A transcode that actually produces an output file, the way ffmpeg would. `bytes` is what it
 * writes, so a test that cares can decide whether the re-encode came out smaller than its source.
 */
function fakeTranscode(bytes = 'opus bytes'): ReturnType<typeof vi.fn<Transcode>> {
  return vi.fn<Transcode>(async ({ dst }) => {
    await writeFile(dst, bytes)
  })
}

/** Where the re-encode is written before the size comparison decides whether it may be kept. */
function stagedPath(id: string): string {
  return path.join(lib.audio, `${id}.opus.staged`)
}

beforeEach(async () => {
  lib = await createTmpLibrary()
  libraryStore = createLibraryStore(lib.root)
})

afterEach(async () => {
  await lib.cleanup()
})

describe('compressExisting', () => {
  it('transcodes to <id>.opus, records the swap, deletes the old file and reports it shrank', async () => {
    const song = await addSongWithFile({ fileName: 'original.wav' })
    const transcode = fakeTranscode()

    const result = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    expect(transcode).toHaveBeenCalledExactlyOnceWith({
      src: path.join(lib.audio, 'original.wav'),
      dst: stagedPath(song.id)
    })
    expect(result.shrank).toBe(true)
    expect(result.song).toEqual({ ...song, fileName: `${song.id}.opus`, compressed: true })
    await expect(libraryStore.getSong(song.id)).resolves.toEqual(result.song)
    expect(await readdir(lib.audio)).toEqual([`${song.id}.opus`])
  })

  /**
   * The tie goes to the original: an equal-sized re-encode is all cost and no gain, so the
   * comparison is `>=`, not `>`. Nothing is recorded either — the row still says uncompressed, so
   * the offer comes back and the user has lost nothing but the ffmpeg run.
   */
  it('keeps the original when the opus re-encode is not smaller', async () => {
    const song = await addSongWithFile({ fileName: 'original.wav' })
    const { size } = await stat(path.join(lib.audio, 'original.wav'))
    const transcode = fakeTranscode('x'.repeat(size))

    const result = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    expect(result.shrank).toBe(false)
    expect(result.song.compressed).toBe(false)
    expect(result.song.fileName).toBe('original.wav')
    await expect(libraryStore.getSong(song.id)).resolves.toEqual(song)
    // The staged opus is gone and the original never moved.
    expect(await readdir(lib.audio)).toEqual(['original.wav'])
  })

  /**
   * An uncompressed `.opus` already named after its id has `src === dst`, so the re-encode is
   * staged beside the target rather than written onto it — transcoding straight onto the source
   * would destroy it before the size comparison could save it. The delete afterwards is skipped,
   * or it would remove the file that was just renamed into place.
   */
  it('replaces an uncompressed .opus in place without deleting anything', async () => {
    const id = 'already-named'
    const song = await addSongWithFile({ id, fileName: `${id}.opus` })
    const transcode = fakeTranscode()

    const result = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    const dst = path.join(lib.audio, `${id}.opus`)
    expect(transcode).toHaveBeenCalledExactlyOnceWith({ src: dst, dst: stagedPath(id) })
    expect(result.shrank).toBe(true)
    expect(result.song.compressed).toBe(true)
    expect(result.song.fileName).toBe(`${id}.opus`)
    expect(existsSync(dst)).toBe(true)
    expect(await readFile(dst, 'utf8')).toBe('opus bytes')
    expect(await readdir(lib.audio)).toEqual([`${id}.opus`])
  })

  /** The same `src === dst` case, but with nothing to keep: the source must survive intact. */
  it('leaves an uncompressed .opus alone when the re-encode is not smaller', async () => {
    const id = 'already-named'
    const song = await addSongWithFile({ id, fileName: `${id}.opus` })
    const dst = path.join(lib.audio, `${id}.opus`)
    const original = await readFile(dst, 'utf8')
    const transcode = fakeTranscode('x'.repeat(original.length))

    const result = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode
    })

    expect(result.shrank).toBe(false)
    expect(result.song.compressed).toBe(false)
    expect(await readFile(dst, 'utf8')).toBe(original)
    expect(await readdir(lib.audio)).toEqual([`${id}.opus`])
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
    // Only `rm` misbehaves: the sizes still have to be read and the staged file still has to land,
    // or the run would fail for a reason that has nothing to do with the delete under test.
    const fs = {
      access: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      stat,
      rename,
      rm: vi.fn(async () => {
        throw new Error('EBUSY')
      })
    }

    const result = await compressExisting(song.id, {
      audioDir: lib.audio,
      libraryStore,
      transcode,
      fs
    })

    expect(result.shrank).toBe(true)
    expect(result.song.compressed).toBe(true)
    expect(fs.rm).toHaveBeenCalledWith(path.join(lib.audio, 'original.wav'), { force: true })
  })
})
