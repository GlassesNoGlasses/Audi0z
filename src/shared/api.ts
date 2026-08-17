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
 * Main API used: ipcMain <-> ipcRenderer format for the app.
 *
 * Member Types:
 * - A promise-returning `ipcRenderer.invoke` endpoint
 * - Subscription that returns its own unsubscribe function
 */

export interface Api {
  library: {
    list(): Promise<SongDto[]>
    add(req: AddSongRequest): Promise<SongDto>
    update(
      id: string,
      patch: { title?: string; tags?: string[]; durationSec?: number }
    ): Promise<SongDto>
    // backfills the duration of newly-added songs in batches
    updateDurations(entries: Array<{ id: string; durationSec: number }>): Promise<SongDto[]>
    remove(id: string): Promise<void>
    compress(id: string): Promise<CompressResult>
    showFolder(): Promise<void>
  }
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
    reorder(orderedIds: string[]): Promise<Playlist[]> // drag+drop reorder on sidebar
    addSong(playlistId: string, songId: string): Promise<Playlist>
    removeSong(playlistId: string, songId: string): Promise<Playlist>
    setPlaybackOptions(id: string, opts: { shuffle?: boolean; repeat?: boolean }): Promise<Playlist>
  }
  files: {
    pickAudioFiles(): Promise<string[]>
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
  events: {
    onLibraryChanged(cb: () => void): () => void
    onError(cb: (e: AppError) => void): () => void
  }
}
