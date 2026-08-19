import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadProgress, DownloadRequest, ProbeResult, Song } from '../../shared/types'
import { createDownloader } from './downloader'
import type { DownloadJob } from './downloader'

const REQUEST: DownloadRequest = {
  url: 'https://example.test/v/1',
  title: 'Some Remix',
  tags: ['edit'],
  compress: true
}

const SONG: Song = {
  id: 'song-1',
  fileName: 'song-1.opus',
  title: 'Some Remix',
  tags: ['edit'],
  addedAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: REQUEST.url,
  compressed: true
}

describe('createDownloader', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mml-downloads-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /** Writes a file next to the out template — what a real yt-dlp run leaves behind. */
  async function writeDownloaded(outTemplate: string): Promise<string> {
    const filePath = outTemplate.replace('%(ext)s', 'm4a')
    await writeFile(filePath, 'downloaded bytes')
    return filePath
  }

  function deps(overrides: Partial<Parameters<typeof createDownloader>[0]> = {}) {
    return {
      tempDir,
      importFile: vi.fn(async () => SONG),
      download: vi.fn(async ({ outTemplate }: DownloadJob) => writeDownloaded(outTemplate)),
      probe: vi.fn(async (url: string, _signal?: AbortSignal) => ({
        title: 'Probed',
        sourceUrl: url
      })),
      ...overrides
    }
  }

  it('imports the downloaded file with deleteSource and cleans the temp job directory', async () => {
    const d = deps()
    const downloader = createDownloader(d)

    await expect(downloader.start(REQUEST)).resolves.toEqual(SONG)

    const outTemplate = vi.mocked(d.download).mock.calls[0][0].outTemplate
    expect(path.dirname(outTemplate)).toMatch(tempDir)
    expect(d.importFile).toHaveBeenCalledWith({
      sourcePath: outTemplate.replace('%(ext)s', 'm4a'),
      title: REQUEST.title,
      tags: REQUEST.tags,
      compress: REQUEST.compress,
      sourceUrl: REQUEST.url,
      deleteSource: true
    })
    expect(await readdir(tempDir)).toEqual([])
  })

  it('rejects a second start while one is running, then accepts one afterwards', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const d = deps({
      download: vi.fn(async ({ outTemplate }: DownloadJob) => {
        await gate
        return writeDownloaded(outTemplate)
      })
    })
    const downloader = createDownloader(d)

    const first = downloader.start(REQUEST)
    await expect(downloader.start(REQUEST)).rejects.toMatchObject({ name: 'BUSY', code: 'BUSY' })

    release()
    await expect(first).resolves.toEqual(SONG)
    expect(d.download).toHaveBeenCalledTimes(1)

    await expect(downloader.start(REQUEST)).resolves.toEqual(SONG)
    expect(d.download).toHaveBeenCalledTimes(2)
  })

  it('rejects the pending start with Cancelled and cleans up when cancelled', async () => {
    let jobDir = ''
    const d = deps({
      download: vi.fn(
        ({ outTemplate, signal }: DownloadJob) =>
          new Promise<string>((_resolve, reject) => {
            jobDir = path.dirname(outTemplate)
            signal.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
      )
    })
    const downloader = createDownloader(d)

    const pending = downloader.start(REQUEST)
    await vi.waitFor(() => expect(jobDir).not.toBe(''))
    expect(existsSync(jobDir)).toBe(true)

    downloader.cancel()

    await expect(pending).rejects.toMatchObject({ name: 'Cancelled', code: 'Cancelled' })
    expect(d.importFile).not.toHaveBeenCalled()
    expect(existsSync(jobDir)).toBe(false)
    expect(await readdir(tempDir)).toEqual([])
  })

  it('cleans the temp job directory when the download fails', async () => {
    const d = deps({
      download: vi.fn(async () => {
        throw new Error('yt-dlp download failed (exit 1)')
      })
    })
    const downloader = createDownloader(d)

    await expect(downloader.start(REQUEST)).rejects.toThrow(/yt-dlp download failed/)
    expect(await readdir(tempDir)).toEqual([])
  })

  it('forwards download progress to every subscriber until it unsubscribes', async () => {
    const progress: DownloadProgress = {
      stage: 'downloading',
      percent: 50,
      bytes: 2048,
      totalBytes: 4096
    }
    const d = deps({
      download: vi.fn(async ({ outTemplate, onProgress }: DownloadJob) => {
        onProgress?.(progress)
        return writeDownloaded(outTemplate)
      })
    })
    const downloader = createDownloader(d)
    const seen: DownloadProgress[] = []
    const unsubscribe = downloader.onProgress((p) => seen.push(p))

    await downloader.start(REQUEST)

    expect(seen[0]).toEqual(progress)
    // The save step has no percentage of its own, but the UI needs to know the stage changed.
    expect(seen.at(-1)).toEqual({ stage: 'saving', percent: null })

    unsubscribe()
    seen.length = 0
    await downloader.start(REQUEST)
    expect(seen).toEqual([])
  })

  it('survives a progress listener that throws, and keeps feeding the others', async () => {
    const progress: DownloadProgress = {
      stage: 'downloading',
      percent: 50,
      bytes: 2048,
      totalBytes: 4096
    }
    const d = deps({
      download: vi.fn(async ({ outTemplate, onProgress }: DownloadJob) => {
        onProgress?.(progress)
        return writeDownloaded(outTemplate)
      })
    })
    const downloader = createDownloader(d)
    // This fan-out runs synchronously inside the child's stdout handler, so an unguarded throw
    // would reach uncaughtException and take the main process down with it.
    const throwing = vi.fn(() => {
      throw new Error('renderer window has been destroyed')
    })
    const seen: DownloadProgress[] = []
    downloader.onProgress(throwing)
    downloader.onProgress((p) => seen.push(p))

    await expect(downloader.start(REQUEST)).resolves.toEqual(SONG)

    expect(throwing).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([progress, { stage: 'saving', percent: null }])
    expect(d.importFile).toHaveBeenCalledTimes(1)
  })

  // Once-per-run lives in `ytdlp.download`; here the seam only has to deliver the callback.
  it('hands the warning callback to the download job', async () => {
    const onWarning = vi.fn()
    const d = deps({
      onWarning,
      download: vi.fn(async ({ outTemplate, onWarning: warn }: DownloadJob) => {
        warn?.('the download may be slow or incomplete')
        return writeDownloaded(outTemplate)
      })
    })

    await createDownloader(d).start(REQUEST)

    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning).toHaveBeenCalledWith('the download may be slow or incomplete')
  })

  it('delegates probe to the injected prober', async () => {
    const d = deps()
    const downloader = createDownloader(d)

    await expect(downloader.probe('https://example.test/v/2')).resolves.toEqual({
      title: 'Probed',
      sourceUrl: 'https://example.test/v/2'
    })
    expect(d.probe).toHaveBeenCalledWith('https://example.test/v/2', expect.any(AbortSignal))
  })

  /**
   * `cancel` is wired to `before-quit`, and a probe is the one yt-dlp run with no cancel button of
   * its own in front of it. Left unreachable, its detached child outlives the app.
   */
  it('cancels an in-flight probe, not just a running download', async () => {
    let probeSignal: AbortSignal | undefined
    const d = deps({
      probe: vi.fn(
        (_url: string, signal?: AbortSignal) =>
          new Promise<ProbeResult>((_resolve, reject) => {
            probeSignal = signal
            signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
      )
    })
    const downloader = createDownloader(d)

    const pending = downloader.probe('https://example.test/v/2')
    await vi.waitFor(() => expect(probeSignal).toBeDefined())

    downloader.cancel()

    await expect(pending).rejects.toMatchObject({ name: 'Cancelled', code: 'Cancelled' })
    expect(probeSignal?.aborted).toBe(true)
  })

  it('ignores cancel when nothing is running', () => {
    expect(() => createDownloader(deps()).cancel()).not.toThrow()
  })
})
