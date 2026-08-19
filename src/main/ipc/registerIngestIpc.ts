import type { IpcMain } from 'electron'
import { IPC, IPC_EVENTS } from '../../shared/ipc'
import type { DownloadProgress, DownloadRequest } from '../../shared/types'
import type { Downloader } from '../ingest/downloader'
import { toSongDto } from './songDto'

export interface IngestIpcDeps {
  downloader: Downloader
  pickAudioFiles(): Promise<string[]>
  sendProgress(channel: string, progress: DownloadProgress): void
  audioDir: string // absolute
  fileSize(absPath: string): Promise<number | null>
}

function invalid(message: string): Error {
  const error = new Error(message)
  error.name = 'InvalidRequest'
  return error
}

// yt-dlp download url validator
function assertUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw invalid('url must be an http(s) URL')
  }
  return value
}

function assertDownloadRequest(value: unknown): DownloadRequest {
  if (typeof value !== 'object' || value === null) {
    throw invalid('download request must be an object')
  }
  const req = value as Record<string, unknown>
  const url = assertUrl(req.url)
  if (typeof req.title !== 'string') throw invalid('title must be a string')
  if (!Array.isArray(req.tags) || req.tags.some((tag) => typeof tag !== 'string')) {
    throw invalid('tags must be an array of strings')
  }
  if (typeof req.compress !== 'boolean') throw invalid('compress must be a boolean')
  return { url, title: req.title, tags: req.tags as string[], compress: req.compress }
}

/** Returns the progress-forwarding unsubscribe, for teardown in tests and on window replacement. */
export function registerIngestIpc(ipc: Pick<IpcMain, 'handle'>, deps: IngestIpcDeps): () => void {
  const unsubscribe = deps.downloader.onProgress((progress) => {
    deps.sendProgress(IPC_EVENTS.downloadProgress, progress)
  })

  ipc.handle(IPC.download.probe, async (_event, url) => deps.downloader.probe(assertUrl(url)))

  // The file is already in place when `start` resolves, so this projects directly — no in-flight
  // compression to settle, unlike the library handlers.
  ipc.handle(IPC.download.start, async (_event, req) =>
    toSongDto(await deps.downloader.start(assertDownloadRequest(req)), deps)
  )

  ipc.handle(IPC.download.cancel, async () => {
    deps.downloader.cancel()
  })

  ipc.handle(IPC.files.pickAudioFiles, async () => deps.pickAudioFiles())

  return unsubscribe
}
