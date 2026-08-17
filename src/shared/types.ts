
export interface Song {
  id: string
  fileName: string // hashed file name in `audi0z` directory
  title: string
  tags: string[]
  addedAt: string
  sourceUrl?: string
  compressed: boolean
  durationSec?: number // updated lazily via `updateDurations` by renderer once
}

// Song DTO for message passing via renderer
export interface SongDto extends Song {
  exists: boolean
  url: string // protocol `media://audio/<id>`
  sizeBytes: number | null // null when !exists
}

export interface CompressResult {
  song: SongDto
  shrank: boolean // false when compression fails/more than original
}

export interface Tag {
  id: string
  name: string
  color: string // #rrggbb
}

export interface Playlist {
  id: string
  name: string
  songIds: string[]
  shuffle: boolean
  repeat: boolean
  createdAt: string
}

// `version: 1` as compatability insurance

export interface Settings {
  version: 1
  compressByDefault: boolean
  volume: number // [0, 1]
  // shuffle/repeat for main Library (playlists have their own)
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
  sourcePath: string // absolute on disk
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

// yt-dlp URL download probe result before download
export interface ProbeResult {
  title: string
  sourceUrl: string
}

export interface DownloadProgress {
  stage: 'downloading' | 'transcoding' | 'saving'
  percent: number | null
  bytes?: number
  totalBytes?: number
}

export interface AppError {
  source: 'ytdlp' | 'ffmpeg' | 'store' | 'trash' | 'import'
  message: string
}
