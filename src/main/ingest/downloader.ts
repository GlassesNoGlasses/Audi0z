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
  onWarning?: (message: string) => void
  signal: AbortSignal
}

export interface DownloaderDeps {
  tempDir: string
  importFile(req: ImportRequest): Promise<Song>
  download(job: DownloadJob): Promise<string>
  probe(url: string, signal: AbortSignal): Promise<ProbeResult>
  // A download that finished, but not as intended — told to the user the way an error is.
  onWarning?: (message: string) => void
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
      } catch {}
    }
  }

  let running: AbortController | null = null
  let probing: AbortController | null = null

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
          onWarning: deps.onWarning,
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

    async probe(url) {
      const controller = new AbortController()
      probing = controller
      try {
        return await deps.probe(url, controller.signal)
      } catch (error) {
        // Same bargain as `start`: however the runner reports an abort, the caller only cares that
        // the cancel was ours.
        throw controller.signal.aborted ? codedError('Cancelled', 'probe cancelled') : error
      } finally {
        // The dialog serialises probes (Fetch disables while one runs), so one slot is enough;
        // clearing only its own keeps a stale finally from wiping a successor's controller.
        if (probing === controller) probing = null
      }
    },

    // `before-quit` calls this, and a probe's child is detached too — leaving one running outlives
    // the app.
    cancel() {
      running?.abort()
      probing?.abort()
    },

    onProgress(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
