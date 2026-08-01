import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadProgress, DownloadRequest, Song } from '../../shared/types'
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
      probe: vi.fn(async (url: string) => ({ title: 'Probed', sourceUrl: url })),
      onProgress: vi.fn(),
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

  it('forwards download progress to the injected sink and to subscribers', async () => {
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

    expect(d.onProgress).toHaveBeenCalledWith(progress)
    expect(seen[0]).toEqual(progress)
    // The save step has no percentage of its own, but the UI needs to know the stage changed.
    expect(seen.at(-1)).toEqual({ stage: 'saving', percent: null })

    unsubscribe()
    seen.length = 0
    await downloader.start(REQUEST)
    expect(seen).toEqual([])
  })

  it('delegates probe to the injected prober', async () => {
    const d = deps()
    const downloader = createDownloader(d)

    await expect(downloader.probe('https://example.test/v/2')).resolves.toEqual({
      title: 'Probed',
      sourceUrl: 'https://example.test/v/2'
    })
    expect(d.probe).toHaveBeenCalledWith('https://example.test/v/2')
  })

  it('ignores cancel when nothing is running', () => {
    expect(() => createDownloader(deps()).cancel()).not.toThrow()
  })
})
