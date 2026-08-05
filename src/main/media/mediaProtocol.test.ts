import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWav } from '../../../tests/support/makeWav'
import { createTmpLibrary, type TmpLibrary } from '../../../tests/support/tmpLibrary'
import type { Song } from '../../shared/types'
import { createMediaHandler, parseRangeHeader, resolveAudioPath } from './mediaProtocol'

const WAV = makeWav(0.25)

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 'song-1',
    fileName: 'song.wav',
    title: 'Song',
    tags: [],
    addedAt: '2024-01-01T00:00:00.000Z',
    compressed: false,
    ...overrides
  }
}

let lib: TmpLibrary
let songs: Map<string, Song>

function handler(): (request: Request) => Promise<Response> {
  return createMediaHandler({
    getSong: async (id) => songs.get(id),
    audioDir: lib.audio
  })
}

/** Releases the file descriptor behind a response we do not read. */
async function drain(response: Response): Promise<void> {
  await response.body?.cancel()
}

beforeEach(async () => {
  lib = await createTmpLibrary()
  songs = new Map([['song-1', song()]])
  await writeFile(path.join(lib.audio, 'song.wav'), WAV)
})

afterEach(async () => {
  await lib.cleanup()
})

describe('parseRangeHeader', () => {
  it('returns null when there is no header', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull()
    expect(parseRangeHeader('', 1000)).toBeNull()
  })

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRangeHeader('bytes=100-', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('parses a closed range and clamps the end to the last byte', () => {
    expect(parseRangeHeader('bytes=100-200', 1000)).toEqual({ start: 100, end: 200 })
    expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('parses a suffix range', () => {
    expect(parseRangeHeader('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('tolerates whitespace', () => {
    expect(parseRangeHeader(' bytes = 0 - 9 ', 1000)).toEqual({ start: 0, end: 9 })
  })

  it.each([
    ['bytes=abc'],
    ['bytes=-'],
    ['0-100'],
    ['items=0-100'],
    ['bytes=200-100'],
    ['bytes=0-100,200-300']
  ])('rejects garbage (%s) so the caller answers 200', (header) => {
    expect(parseRangeHeader(header, 1000)).toBeNull()
  })

  it('reports a start past the end of the file as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=999999-', 1000)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=1000-1200', 1000)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable')
  })
})

describe('resolveAudioPath', () => {
  it('resolves a plain file name inside the audio directory', () => {
    expect(resolveAudioPath('/library/audio', 'song.wav')).toBe(
      path.resolve('/library/audio', 'song.wav')
    )
  })

  it.each([['../../etc/passwd'], ['..'], [''], ['/etc/passwd'], ['sub/../../escape.wav']])(
    'refuses to escape the audio directory (%s)',
    (fileName) => {
      expect(resolveAudioPath('/library/audio', fileName)).toBeNull()
    }
  )

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    expect(resolveAudioPath('/library/audio', '../audio-other/song.wav')).toBeNull()
  })
})

describe('createMediaHandler', () => {
  it('answers a request without a Range header with 200 and the whole file', async () => {
    const response = await handler()(new Request('media://audio/song-1'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe(String(WAV.length))
    expect(response.headers.get('Content-Type')).toBe('audio/wav')
    expect(Buffer.from(await response.arrayBuffer()).equals(WAV)).toBe(true)
  })

  it('uses the file extension for the content type', async () => {
    songs.set('opus-1', song({ id: 'opus-1', fileName: 'song.opus', compressed: true }))
    await writeFile(path.join(lib.audio, 'song.opus'), WAV)

    const response = await handler()(new Request('media://audio/opus-1'))

    expect(response.headers.get('Content-Type')).toBe('audio/ogg')
    await drain(response)
  })

  it('answers a Range request with 206 and exactly the requested bytes', async () => {
    const response = await handler()(
      new Request('media://audio/song-1', { headers: { Range: 'bytes=4-9' } })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes 4-9/${WAV.length}`)
    expect(response.headers.get('Content-Length')).toBe('6')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')

    const body = Buffer.from(await response.arrayBuffer())
    expect(body).toHaveLength(6)
    expect(body.equals(WAV.subarray(4, 10))).toBe(true)
  })

  it('answers an unsatisfiable range with 416 and the file size', async () => {
    const response = await handler()(
      new Request('media://audio/song-1', { headers: { Range: 'bytes=999999999-' } })
    )

    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe(`bytes */${WAV.length}`)
  })

  it('answers 404 for an unknown song id', async () => {
    const response = await handler()(new Request('media://audio/nope'))

    expect(response.status).toBe(404)
  })

  it.each([['media://audio/'], ['media://audio'], ['media://other/song-1']])(
    'answers 404 for a malformed url (%s)',
    async (url) => {
      expect((await handler()(new Request(url))).status).toBe(404)
    }
  )

  it('answers 404 when the backing file is missing', async () => {
    songs.set('ghost', song({ id: 'ghost', fileName: 'not-on-disk.wav' }))

    const response = await handler()(new Request('media://audio/ghost'))

    expect(response.status).toBe(404)
  })

  it('answers 404 for a fileName that tries to escape the audio directory', async () => {
    songs.set('evil', song({ id: 'evil', fileName: '../../etc/passwd' }))

    const response = await handler()(new Request('media://audio/evil'))

    expect(response.status).toBe(404)
  })

  it('answers 404 when the store throws', async () => {
    const failing = createMediaHandler({
      getSong: () => Promise.reject(new Error('disk gone')),
      audioDir: lib.audio
    })

    expect((await failing(new Request('media://audio/song-1'))).status).toBe(404)
  })

  /**
   * A request that races an in-flight compression must not stream the file being replaced: it
   * waits for the job and serves whatever the record says afterwards. The untouched `lookups` is
   * the load-bearing half — the wait has to come before the record is read, or the handler would
   * stat the pre-swap `fileName` and hand the renderer a file that is about to vanish.
   */
  it('holds a request for a compressing song until the swap has settled', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const lookups: string[] = []
    const compressing = createMediaHandler({
      getSong: async (id) => {
        lookups.push(id)
        return songs.get(id)
      },
      audioDir: lib.audio,
      awaitCompression: () => gate
    })

    const pending = compressing(new Request('media://audio/song-1'))
    let served = false
    void pending.then(() => (served = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lookups).toEqual([])
    expect(served).toBe(false)

    release()
    const response = await pending

    expect(lookups).toEqual(['song-1'])
    expect(response.status).toBe(200)
    await drain(response)
  })

  /** The dep is optional: with nothing tracking compressions the handler waits on nothing. */
  it('serves straight through when no compression tracker is wired in', async () => {
    const response = await handler()(new Request('media://audio/song-1'))

    expect(response.status).toBe(200)
    await drain(response)
  })

  it('destroys the read stream when the request is aborted', async () => {
    let opened: Readable | undefined
    const aborting = createMediaHandler({
      getSong: async (id) => songs.get(id),
      audioDir: lib.audio,
      fs: {
        stat: async () => ({ size: WAV.length }),
        createReadStream: (filePath, options) => {
          opened = createReadStream(filePath, options)
          return opened
        }
      }
    })
    const controller = new AbortController()

    await aborting(new Request('media://audio/song-1', { signal: controller.signal }))
    controller.abort()

    await vi.waitFor(() => {
      expect(opened?.destroyed).toBe(true)
    })
  })
})
