import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import type { Song } from '../../shared/types'
import { fileSize } from '../wiring'
import { toSongDto } from './songDto'

const SONG: Song = {
  id: 'song-1',
  fileName: 'song-1.opus',
  title: 'Nightdrive',
  tags: ['edit'],
  addedAt: '2026-01-01T00:00:00.000Z',
  compressed: true
}

let lib: TmpLibrary

beforeEach(async () => {
  lib = await createTmpLibrary()
})

afterEach(async () => {
  await lib.cleanup()
})

/** The production pairing: the real `fileSize` against real files in a real audio directory. */
function realDeps(): { audioDir: string; fileSize: typeof fileSize } {
  return { audioDir: lib.audio, fileSize }
}

describe('toSongDto', () => {
  it('measures a file that is there and reports it as existing', async () => {
    const bytes = Buffer.from('opus-ish payload')
    await writeFile(path.join(lib.audio, SONG.fileName), bytes)

    const dto = await toSongDto(SONG, realDeps())

    expect(dto).toEqual({
      ...SONG,
      exists: true,
      url: 'media://audio/song-1',
      sizeBytes: bytes.byteLength
    })
  })

  it('reports sizeBytes null and exists false for a file that is not there', async () => {
    const dto = await toSongDto(SONG, realDeps())

    expect(dto.sizeBytes).toBeNull()
    expect(dto.exists).toBe(false)
  })

  /** A 0-byte file is present, however useless — it must not collapse into "missing". */
  it('treats a zero-byte file as existing', async () => {
    await writeFile(path.join(lib.audio, SONG.fileName), '')

    const dto = await toSongDto(SONG, realDeps())

    expect(dto.sizeBytes).toBe(0)
    expect(dto.exists).toBe(true)
  })

  /**
   * The id is a uuid in practice, but `library.json` is hand-editable and `mediaProtocol` decodes
   * what it finds in the path — so it has to be encoded on the way out or the two disagree.
   */
  it('percent-encodes the song id into the media url', async () => {
    const id = 'a b#c?d&e'

    const dto = await toSongDto({ ...SONG, id }, realDeps())

    expect(dto.url).toBe('media://audio/a%20b%23c%3Fd%26e')
    expect(decodeURIComponent(new URL(dto.url).pathname.slice(1))).toBe(id)
  })

  /** `fileName` is written by the importer, but the same containment rule applies as everywhere. */
  it('refuses to measure a fileName that resolves outside the audio directory', async () => {
    const fileSizeSpy = vi.fn(async (_absPath: string): Promise<number | null> => 4096)

    const dto = await toSongDto(
      { ...SONG, fileName: path.join('..', '..', 'etc', 'passwd') },
      { audioDir: lib.audio, fileSize: fileSizeSpy }
    )

    expect(fileSizeSpy).not.toHaveBeenCalled()
    expect(dto.sizeBytes).toBeNull()
    expect(dto.exists).toBe(false)
  })

  it('measures the resolved path inside the audio directory exactly once', async () => {
    const fileSizeSpy = vi.fn(async (_absPath: string): Promise<number | null> => 4096)

    await toSongDto(SONG, { audioDir: lib.audio, fileSize: fileSizeSpy })

    expect(fileSizeSpy).toHaveBeenCalledExactlyOnceWith(path.join(lib.audio, SONG.fileName))
  })
})
