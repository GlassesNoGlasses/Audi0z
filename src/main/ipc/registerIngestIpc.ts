import type { IpcMain } from 'electron'
import { IPC, IPC_EVENTS, MEDIA_SCHEME } from '../../shared/ipc'
import type { DownloadProgress, DownloadRequest, Song, SongDto } from '../../shared/types'
import type { Downloader } from '../ingest/downloader'

/**
 * The ingest half of the main-process IPC surface: downloads, the file picker and the yt-dlp
 * self-update.
 *
 * `electron` is only imported as a *type* — the picker and the renderer send are injected, so this
 * module runs in a plain node test with a fake `ipc`.
 */

export interface IngestIpcDeps {
  downloader: Downloader
  updateYtDlp(): Promise<{ version: string }>
  /** Shows the OS file dialog; returns the chosen absolute paths (empty when cancelled). */
  pickAudioFiles(): Promise<string[]>
  /**
   * Pushes to the renderer — `webContents.send` with the window already bound. Must not throw: it
   * runs inside the download's progress path, so a destroyed window has to be checked for here.
   */
  sendProgress(channel: string, progress: DownloadProgress): void
}

function invalid(message: string): Error {
  const error = new Error(message)
  error.name = 'InvalidRequest'
  return error
}

function assertUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('url must be a non-empty string')
  }
  return value
}

/** The renderer is trusted, but a malformed payload must fail here rather than reach yt-dlp. */
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

/**
 * A freshly imported song is on disk by definition, so `exists` is true and the media URL follows
 * straight from the id. (WP2's library IPC builds the same DTO for songs read back from the store.)
 */
function toSongDto(song: Song): SongDto {
  return { ...song, exists: true, url: `${MEDIA_SCHEME}://audio/${song.id}` }
}

/** Returns the progress-forwarding unsubscribe, for teardown in tests and on window replacement. */
export function registerIngestIpc(ipc: Pick<IpcMain, 'handle'>, deps: IngestIpcDeps): () => void {
  const unsubscribe = deps.downloader.onProgress((progress) => {
    deps.sendProgress(IPC_EVENTS.downloadProgress, progress)
  })

  ipc.handle(IPC.download.probe, async (_event, url) => deps.downloader.probe(assertUrl(url)))

  ipc.handle(IPC.download.start, async (_event, req) =>
    toSongDto(await deps.downloader.start(assertDownloadRequest(req)))
  )

  ipc.handle(IPC.download.cancel, async () => {
    deps.downloader.cancel()
  })

  ipc.handle(IPC.files.pickAudioFiles, async () => deps.pickAudioFiles())

  ipc.handle(IPC.ytdlp.update, async () => deps.updateYtDlp())

  return unsubscribe
}
