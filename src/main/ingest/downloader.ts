import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, DownloadRequest, ProbeResult, Song } from '../../shared/types'
import type { ImportRequest } from './importer'

/**
 * One download at a time, into a throwaway temp directory, then straight into the library.
 *
 * Every collaborator is injected — yt-dlp, the importer — and progress leaves through a
 * subscription, so the whole flow, including cancellation, is testable without a child process.
 */

/** What `ytdlp.download` needs once its binary/ffmpeg paths are bound. */
export interface DownloadJob {
  url: string
  outTemplate: string
  onProgress?: (progress: DownloadProgress) => void
  signal: AbortSignal
}

export interface DownloaderDeps {
  /** Parent directory for per-job temp directories (`app.getPath('temp')` in production). */
  tempDir: string
  importFile(req: ImportRequest): Promise<Song>
  download(job: DownloadJob): Promise<string>
  probe(url: string): Promise<ProbeResult>
}

export interface Downloader {
  /** Rejects with a `BUSY` error if a download is already running. */
  start(req: DownloadRequest): Promise<Song>
  probe(url: string): Promise<ProbeResult>
  /** No-op when idle; otherwise the pending `start` rejects with a `Cancelled` error. */
  cancel(): void
  /** Subscribe to progress. Returns the unsubscribe function. */
  onProgress(listener: (progress: DownloadProgress) => void): () => void
}

interface CodedError extends Error {
  code: string
}

/**
 * Name *and* code, for the two audiences.
 *
 * In-process callers (`withErrorReport`, which lets a `Cancelled` pass unreported) read `name` or
 * `code` directly. The renderer gets neither: `ipcMain.handle` serialises a rejection into a plain
 * `Error` whose own `name` is `Error`, pasting the original name into the *message* instead — which
 * is why `renderer/lib/errors.ts` has to match on the message text.
 */
function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError
  error.name = code
  error.code = code
  return error
}

export function createDownloader(deps: DownloaderDeps): Downloader {
  const listeners = new Set<(progress: DownloadProgress) => void>()

  /**
   * Listener failures are swallowed, deliberately.
   *
   * This fan-out runs synchronously inside the child's stdout handler, so an unguarded throw would
   * not reject the download — it would reach `uncaughtException` and take the whole main process
   * down over a progress tick. The sink's contract already says it must not throw
   * (`IngestIpcDeps.sendProgress`), so a throw here is that listener's bug, and one bad listener
   * must not starve the others. Nothing is logged: the main process has no logger seam yet, and
   * console noise from a packaged app helps nobody — if progress reporting ever needs diagnosing,
   * a `onListenerError` dep is the honest way to add it.
   */
  const emit = (progress: DownloadProgress): void => {
    for (const listener of [...listeners]) {
      try {
        listener(progress)
      } catch {
        // See above: keep going.
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
        // Nothing in here is worth keeping, on success or failure — and a failed cleanup must not
        // turn a good import into a rejection.
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
