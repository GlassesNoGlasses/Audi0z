import type { Playlist, Settings, Song } from '../../shared/types'

/**
 * Persistence seam for the main process. WP2 implements these against atomic JSON files; other
 * work packages mock them.
 *
 * Deliberately free of any `electron` import — stores take an explicit library directory so they
 * can be constructed in a unit test against a temp dir with no app instance in sight.
 *
 * Every method is async: a store is disk-backed, and an async contract can be satisfied by a
 * synchronous implementation while the reverse is not true.
 */

export interface LibraryStore {
  list(): Promise<Song[]>
  /** Single-song lookup, used by the `media://` protocol handler on every range request. */
  getSong(id: string): Promise<Song | undefined>
  add(song: Song): Promise<Song>
  update(id: string, patch: Partial<Pick<Song, 'title' | 'tags'>>): Promise<Song>
  remove(id: string): Promise<void>
}

export interface PlaylistStore {
  list(): Promise<Playlist[]>
  create(name: string): Promise<Playlist>
  rename(id: string, name: string): Promise<Playlist>
  remove(id: string): Promise<void>
  addSong(playlistId: string, songId: string): Promise<Playlist>
  removeSong(playlistId: string, songId: string): Promise<Playlist>
  setPlaybackOptions(id: string, opts: { shuffle?: boolean; repeat?: boolean }): Promise<Playlist>
  /** Drop a song from every playlist that references it — called when a song is deleted. */
  cascadeRemoveSong(songId: string): Promise<void>
}

export interface SettingsStore {
  get(): Promise<Settings>
  set(patch: Partial<Settings>): Promise<Settings>
}

/**
 * Factory signatures. `dir` is the library root (the directory holding `library.json`,
 * `playlists.json`, `settings.json` and `audio/`).
 */
export type CreateLibraryStore = (dir: string) => LibraryStore
export type CreatePlaylistStore = (dir: string) => PlaylistStore
export type CreateSettingsStore = (dir: string) => SettingsStore
