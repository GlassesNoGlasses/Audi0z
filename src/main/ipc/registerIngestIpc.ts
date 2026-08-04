import type { IpcMain } from 'electron'
import { IPC, IPC_EVENTS, MEDIA_SCHEME } from '../../shared/ipc'
import type { DownloadProgress, DownloadRequest, Song, SongDto } from '../../shared/types'
import type { Downloader } from '../ingest/downloader'
import { resolveAudioPath } from '../media/mediaProtocol'

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
  /** Absolute path of the library's `audio/` directory — the same one `registerLibraryIpc` gets. */
  audioDir: string
  /**
   * **Must not reject** — `null` means "could not measure". Used to fill the download DTO's
   * `sizeBytes`, which `SongDto` promises is null exactly when `exists` is false.
   */
  fileSize(absPath: string): Promise<number | null>
}

function invalid(message: string): Error {
  const error = new Error(message)
  error.name = 'InvalidRequest'
  return error
}

/**
 * http(s) only, and the scheme must start the string.
 *
 * yt-dlp takes the URL as a positional argument and the frozen arg lists carry no `--` terminator,
 * so an option-shaped value (`--config-locations=/tmp/x`) would reach argv as a *flag* rather than
 * as something to fetch. Anchoring on `https?://` rules that out along with `file://` and friends.
 * Leading whitespace is not trimmed away — a padded URL is simply rejected.
 *
 * Case-insensitive on the scheme only: RFC 3986 schemes are, and a link pasted out of a document
 * or an email client arrives as `HTTPS://` often enough that rejecting it reads as the app not
 * understanding the URL. The anchor still does the work that matters.
 */
function assertUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw invalid('url must be an http(s) URL')
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
 * Builds the DTO for a freshly downloaded song. Same shape and same rules as the one
 * `registerLibraryIpc` builds for songs read back from the store, deliberately: one measurement
 * answers both questions, so `exists` and `sizeBytes` cannot disagree and a 0-byte file reads as
 * present rather than missing.
 *
 * The file was just written, so this normally resolves to a real size — but it is measured rather
 * than assumed, because `SongDto` promises `sizeBytes` is null *exactly* when `exists` is false and
 * the renderer is entitled to read it that way.
 *
 * The id is encoded because `mediaProtocol` decodes it: ids are uuids in practice, but
 * `library.json` is hand-editable, and the two halves have to agree whatever is in there.
 */
async function toSongDto(song: Song, deps: IngestIpcDeps): Promise<SongDto> {
  const resolved = resolveAudioPath(deps.audioDir, song.fileName)
  const size = resolved === null ? null : await deps.fileSize(resolved)
  return {
    ...song,
    exists: size !== null,
    url: `${MEDIA_SCHEME}://audio/${encodeURIComponent(song.id)}`,
    sizeBytes: size
  }
}

/** Returns the progress-forwarding unsubscribe, for teardown in tests and on window replacement. */
export function registerIngestIpc(ipc: Pick<IpcMain, 'handle'>, deps: IngestIpcDeps): () => void {
  const unsubscribe = deps.downloader.onProgress((progress) => {
    deps.sendProgress(IPC_EVENTS.downloadProgress, progress)
  })

  ipc.handle(IPC.download.probe, async (_event, url) => deps.downloader.probe(assertUrl(url)))

  ipc.handle(IPC.download.start, async (_event, req) =>
    toSongDto(await deps.downloader.start(assertDownloadRequest(req)), deps)
  )

  ipc.handle(IPC.download.cancel, async () => {
    deps.downloader.cancel()
  })

  ipc.handle(IPC.files.pickAudioFiles, async () => deps.pickAudioFiles())

  ipc.handle(IPC.ytdlp.update, async () => deps.updateYtDlp())

  return unsubscribe
}
