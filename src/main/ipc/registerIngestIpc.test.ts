import path from 'node:path'
import type { IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC, IPC_EVENTS } from '../../shared/ipc'
import type { DownloadProgress, Song, SongDto } from '../../shared/types'
import { registerIngestIpc } from './registerIngestIpc'

const AUDIO_DIR = path.join(path.sep, 'library', 'audio')

const SONG: Song = {
  id: 'song-1',
  fileName: 'song-1.opus',
  title: 'Some Remix',
  tags: ['edit'],
  addedAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.test/v/1',
  compressed: true
}

const VALID_REQUEST = {
  url: 'https://example.test/v/1',
  title: 'Some Remix',
  tags: ['edit'],
  compress: true
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup() {
  const handlers = new Map<string, Handler>()
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    })
  } as unknown as Pick<IpcMain, 'handle'>

  const listeners = new Set<(p: DownloadProgress) => void>()
  const downloader = {
    start: vi.fn(async () => SONG),
    probe: vi.fn(async (url: string) => ({ title: 'Probed', sourceUrl: url })),
    cancel: vi.fn(),
    onProgress: vi.fn((listener: (p: DownloadProgress) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })
  }
  const deps = {
    downloader,
    pickAudioFiles: vi.fn(async () => ['/music/a.mp3']),
    sendProgress: vi.fn(),
    audioDir: AUDIO_DIR,
    fileSize: vi.fn(async (_absPath: string): Promise<number | null> => 8192)
  }

  const unsubscribe = registerIngestIpc(ipc, deps)

  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler registered for ${channel}`)
    return (await handler({}, ...args)) as T
  }

  const emitProgress = (p: DownloadProgress): void => {
    for (const listener of [...listeners]) listener(p)
  }

  return { deps, downloader, handlers, invoke, emitProgress, unsubscribe }
}

describe('registerIngestIpc', () => {
  it('wires exactly the four ingest channels', () => {
    const { handlers } = setup()

    expect([...handlers.keys()].sort()).toEqual(
      [IPC.download.probe, IPC.download.start, IPC.download.cancel, IPC.files.pickAudioFiles].sort()
    )
  })

  it('delegates probe, start, cancel and file picking', async () => {
    const { deps, downloader, invoke } = setup()

    await expect(invoke(IPC.download.probe, 'https://example.test/v/1')).resolves.toEqual({
      title: 'Probed',
      sourceUrl: 'https://example.test/v/1'
    })

    await expect(invoke(IPC.download.start, VALID_REQUEST)).resolves.toEqual({
      ...SONG,
      exists: true,
      url: `media://audio/${SONG.id}`,
      sizeBytes: 8192
    })
    expect(downloader.start).toHaveBeenCalledWith(VALID_REQUEST)

    await expect(invoke(IPC.download.cancel)).resolves.toBeUndefined()
    expect(downloader.cancel).toHaveBeenCalledTimes(1)

    await expect(invoke(IPC.files.pickAudioFiles)).resolves.toEqual(['/music/a.mp3'])
    expect(deps.pickAudioFiles).toHaveBeenCalledTimes(1)
  })

  it('forwards downloader progress on the download progress channel', () => {
    const { deps, emitProgress, unsubscribe } = setup()
    const progress: DownloadProgress = {
      stage: 'downloading',
      percent: 25,
      bytes: 1,
      totalBytes: 4
    }

    emitProgress(progress)

    expect(deps.sendProgress).toHaveBeenCalledWith(IPC_EVENTS.downloadProgress, progress)

    unsubscribe()
    emitProgress(progress)
    expect(deps.sendProgress).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['null', null],
    ['a non-object', 'https://example.test/v/1'],
    ['a missing url', { ...VALID_REQUEST, url: undefined }],
    ['an empty url', { ...VALID_REQUEST, url: '  ' }],
    ['an option-shaped url', { ...VALID_REQUEST, url: '--config-locations=/tmp/x' }],
    ['a non-http url', { ...VALID_REQUEST, url: 'ftp://example.test/x' }],
    ['a non-string title', { ...VALID_REQUEST, title: 7 }],
    ['non-array tags', { ...VALID_REQUEST, tags: 'edit' }],
    ['non-string tags', { ...VALID_REQUEST, tags: ['ok', 3] }],
    ['a non-boolean compress', { ...VALID_REQUEST, compress: 'yes' }]
  ])('rejects a download request with %s', async (_label, payload) => {
    const { downloader, invoke } = setup()

    await expect(invoke(IPC.download.start, payload)).rejects.toThrow()
    expect(downloader.start).not.toHaveBeenCalled()
  })

  // yt-dlp takes the URL as a positional arg and the frozen arg lists carry no `--` terminator, so
  // an option-shaped string would be parsed as a flag rather than fetched.
  it.each([
    ['undefined', undefined],
    ['an empty string', '   '],
    ['a number', 42],
    ['an option-shaped string', '--config-locations=/tmp/x'],
    ['a short option', '-o/tmp/pwned'],
    ['an ftp url', 'ftp://example.test/x'],
    ['a file url', 'file:///etc/passwd'],
    ['a scheme-less host', 'example.test/v/1'],
    ['a padded url', '  https://example.test/v/1']
  ])('rejects a probe for %s', async (_label, payload) => {
    const { downloader, invoke } = setup()

    await expect(invoke(IPC.download.probe, payload)).rejects.toThrow()
    expect(downloader.probe).not.toHaveBeenCalled()
  })

  // RFC 3986 schemes are case-insensitive, and a URL pasted out of a document or an email client
  // arrives capitalised often enough that rejecting it reads as the app not understanding the link.
  it.each([
    ['https', 'https://example.test/v/1'],
    ['http', 'http://example.test/v/1'],
    ['uppercase HTTPS', 'HTTPS://example.test/v/1'],
    ['mixed-case HtTp', 'HtTp://example.test/v/1']
  ])('accepts a plain %s url', async (_label, url) => {
    const { downloader, invoke } = setup()

    await expect(invoke(IPC.download.probe, url)).resolves.toMatchObject({ sourceUrl: url })
    expect(downloader.probe).toHaveBeenCalledWith(url)
  })

  it('accepts an uppercase scheme on a download request too', async () => {
    const { downloader, invoke } = setup()
    const request = { ...VALID_REQUEST, url: 'HTTPS://example.test/v/1' }

    await expect(invoke(IPC.download.start, request)).resolves.toMatchObject({ id: SONG.id })
    expect(downloader.start).toHaveBeenCalledWith(request)
  })
})

/**
 * The projection's invariants (missing/zero-byte files, id encoding, out-of-dir fileName) are
 * pinned in `songDto.test.ts`; here one end-to-end shape check pins that this handler routes
 * through that projection at all.
 */
describe('download:start DTO', () => {
  it('measures the downloaded file inside the audio directory', async () => {
    const { deps, invoke } = setup()

    const dto = await invoke<SongDto>(IPC.download.start, VALID_REQUEST)

    expect(deps.fileSize).toHaveBeenCalledExactlyOnceWith(path.join(AUDIO_DIR, SONG.fileName))
    expect(dto.sizeBytes).toBe(8192)
    expect(dto.exists).toBe(true)
    expect(dto.url).toBe(`media://audio/${SONG.id}`)
  })
})
