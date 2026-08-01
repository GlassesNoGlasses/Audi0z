import type {
  AddSongRequest,
  AppError,
  DownloadProgress,
  DownloadRequest,
  Playlist,
  ProbeResult,
  Settings,
  SongDto
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
    update(id: string, patch: { title?: string; tags?: string[] }): Promise<SongDto>
    remove(id: string): Promise<void>
    revealInFolder(id: string): Promise<void>
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
