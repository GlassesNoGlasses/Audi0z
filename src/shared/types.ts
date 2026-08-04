/**
 * Frozen domain contracts. Shared by main, preload and renderer.
 *
 * These shapes are also the on-disk JSON schema, so changing one is a migration.
 */

/** A song as persisted in `library.json`. */
export interface Song {
  id: string
  /** File name inside the library's `audio/` directory — never an absolute path. */
  fileName: string
  title: string
  tags: string[]
  /** ISO 8601 timestamp. */
  addedAt: string
  /** Set when the song came from a URL download. */
  sourceUrl?: string
  /** True when the audio was transcoded to Opus on the way in. */
  compressed: boolean
  /**
   * Playing time in whole seconds. Absent until something has measured it — the renderer probes it
   * lazily off the `<audio>` element and writes it back, because reading it in the main process
   * would mean an ffprobe run per song at startup.
   */
  durationSec?: number
}

/** A song as handed to the renderer: enriched with playback/presence info. */
export interface SongDto extends Song {
  /** False when the backing file is missing from disk. */
  exists: boolean
  /** `media://audio/<id>` */
  url: string
  /** On-disk size in bytes; `null` exactly when `exists` is false. */
  sizeBytes: number | null
}

/** A tag in the registry — the named, coloured thing the UI filters by. */
export interface Tag {
  id: string
  name: string
  /** '#rrggbb', assigned randomly at creation. */
  color: string
}

export interface Playlist {
  id: string
  name: string
  /** Ordered song ids. May reference songs that were since removed only transiently. */
  songIds: string[]
  shuffle: boolean
  repeat: boolean
  /** ISO 8601 timestamp. */
  createdAt: string
}

export interface Settings {
  version: 1
  compressByDefault: boolean
  /** 0..1 */
  volume: number
  /** Shuffle/repeat for the Library view (playlists carry their own). */
  libraryShuffle: boolean
  libraryRepeat: boolean
}

export interface LibraryFile {
  version: 1
  songs: Song[]
}

export interface PlaylistsFile {
  version: 1
  playlists: Playlist[]
}

export interface TagsFile {
  version: 1
  tags: Tag[]
}

export interface AddSongRequest {
  /** Absolute path of the source file on disk. */
  sourcePath: string
  title: string
  tags: string[]
  compress: boolean
}

export interface DownloadRequest {
  url: string
  title: string
  tags: string[]
  compress: boolean
}

export interface ProbeResult {
  title: string
  durationSec?: number
  sourceUrl: string
}

export interface DownloadProgress {
  stage: 'downloading' | 'transcoding' | 'saving'
  /** 0..100, or null when the stage cannot report a percentage. */
  percent: number | null
  bytes?: number
  totalBytes?: number
}

export interface AppError {
  source: 'ytdlp' | 'ffmpeg' | 'store' | 'trash' | 'import'
  message: string
}
