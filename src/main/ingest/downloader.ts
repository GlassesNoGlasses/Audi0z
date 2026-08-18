import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, DownloadRequest, ProbeResult, Song } from '../../shared/types'
import type { ImportRequest } from './importer'

/** What `ytdlp.download` needs once its binary/ffmpeg paths are bound. */
export interface DownloadJob {
  url: string
  outTemplate: string
  onProgress?: (progress: DownloadProgress) => void
  signal: AbortSignal
}

export interface DownloaderDeps {
  tempDir: string
  importFile(req: ImportRequest): Promise<Song>
  download(job: DownloadJob): Promise<string>
  probe(url: string): Promise<ProbeResult>
}

export interface Downloader {
  start(req: DownloadRequest): Promise<Song>
  probe(url: string): Promise<ProbeResult>
  cancel(): void
  onProgress(listener: (progress: DownloadProgress) => void): () => void
}

interface CodedError extends Error {
  code: string
}

function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError
  error.name = code
  error.code = code
  return error
}

/** Main downloader used by `yt-dlp` and called by ipcRenderer */
export function createDownloader(deps: DownloaderDeps): Downloader {
  const listeners = new Set<(progress: DownloadProgress) => void>()
  const emit = (progress: DownloadProgress): void => {
    for (const listener of [...listeners]) {
      try {
        listener(progress)
      } catch {
      }
    }
  }

  let running: AbortController | null = null

  return {
    async start(req) {
      if (running) throw codedError('BUSY', 'a download is already running')

      const controller = new AbortController()
      running = controller
      const jobDir = path.join(deps.tempDir, `mml-download-${randomUUID()}`)

      try {
        await mkdir(jobDir, { recursive: true })

        // yt-dlp picks the extension, so the name is fixed and the real path comes back from it.
        const filePath = await deps.download({
          url: req.url,
          outTemplate: path.join(jobDir, 'download.%(ext)s'),
          onProgress: emit,
          signal: controller.signal
        })
        if (controller.signal.aborted) throw codedError('Cancelled', 'download cancelled')

        emit({ stage: 'saving', percent: null })

        return await deps.importFile({
          sourcePath: filePath,
          title: req.title,
          tags: req.tags,
          compress: req.compress,
          sourceUrl: req.url,
          deleteSource: true
        })
      } catch (error) {
        // An aborted run fails in whatever way the runner chose; callers only care that it was us.
        throw controller.signal.aborted ? codedError('Cancelled', 'download cancelled') : error
      } finally {
        // cleanup temp dirs and files
        await rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
        running = null
      }
    },

    probe(url) {
      return deps.probe(url)
    },

    cancel() {
      running?.abort()
    },

    onProgress(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
