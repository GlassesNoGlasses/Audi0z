import type {
  AddSongRequest,
  AppError,
  CompressResult,
  DownloadProgress,
  DownloadRequest,
  Playlist,
  ProbeResult,
  Settings,
  SongDto,
  Tag
} from './types'

/**
 * The frozen renderer <-> main contract, exposed by the preload as `window.api`.
 *
 * Every member is either a promise-returning `ipcRenderer.invoke` passthrough, a synchronous
 * preload-local helper (`files.getPathForFile`), or a subscription that returns its own
 * unsubscribe function.
 */
export interface Api {
  library: {
    list(): Promise<SongDto[]>
    add(req: AddSongRequest): Promise<SongDto>
    update(
      id: string,
      patch: { title?: string; tags?: string[]; durationSec?: number }
    ): Promise<SongDto>
    /** One write for a whole batch of measured durations; ids that vanished mid-flight are skipped. */
    updateDurations(entries: Array<{ id: string; durationSec: number }>): Promise<SongDto[]>
    remove(id: string): Promise<void>
    /**
     * Transcodes an already-imported song to Opus in place. Rejects if it is already compressed.
     *
     * Resolving is not the same as having compressed: a re-encode that came out no smaller is
     * thrown away and the original kept, which resolves with `shrank: false` and an unchanged song.
     */
    compress(id: string): Promise<CompressResult>
    /** Opens the library's `audio/` directory itself, rather than a single song inside it. */
    showFolder(): Promise<void>
  }
  /**
   * The tag registry. Songs still carry tags as plain strings; this is the named/coloured index of
   * them, so renaming a tag in one place renames it on every song.
   */
  tags: {
    list(): Promise<Tag[]>
    create(name: string): Promise<Tag>
    rename(id: string, name: string): Promise<Tag>
    remove(id: string): Promise<void>
  }
  playlists: {
    list(): Promise<Playlist[]>
    create(name: string): Promise<Playlist>
    remove(id: string): Promise<void>
    rename(id: string, name: string): Promise<Playlist>
    addSong(playlistId: string, songId: string): Promise<Playlist>
    removeSong(playlistId: string, songId: string): Promise<Playlist>
    setPlaybackOptions(id: string, opts: { shuffle?: boolean; repeat?: boolean }): Promise<Playlist>
  }
  files: {
    pickAudioFiles(): Promise<string[]>
    /** Synchronous: Electron removed `File.path`, so drag-and-drop paths come from `webUtils`. */
    getPathForFile(file: File): string
  }
  download: {
    probe(url: string): Promise<ProbeResult>
    start(req: DownloadRequest): Promise<SongDto>
    cancel(): Promise<void>
    onProgress(cb: (p: DownloadProgress) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  ytdlp: {
    update(): Promise<{ version: string }>
  }
  events: {
    onLibraryChanged(cb: () => void): () => void
    onError(cb: (e: AppError) => void): () => void
  }
}
