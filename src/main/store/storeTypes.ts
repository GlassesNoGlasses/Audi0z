import type { Playlist, Settings, Song, Tag } from '../../shared/types'

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
  update(id: string, patch: Partial<Pick<Song, 'title' | 'tags' | 'durationSec'>>): Promise<Song>
  /**
   * Records a batch of measured playing times in a single persist, and answers with the songs it
   * matched. Ids that are no longer in the library are skipped rather than refused — a song can be
   * deleted between the probe that measured it and the write.
   */
  updateDurations(entries: ReadonlyArray<{ id: string; durationSec: number }>): Promise<Song[]>
  remove(id: string): Promise<void>
  /**
   * Rewrites one tag name across the whole library in a single persist. A song that already carries
   * `newName` loses `oldName` rather than ending up with it twice.
   */
  renameTag(oldName: string, newName: string): Promise<void>
  /** Drops one tag name from every song, in a single persist. */
  removeTag(name: string): Promise<void>
  /** Points a song at a different file — how an in-place compression is recorded. */
  replaceFile(id: string, fileName: string, compressed: boolean): Promise<Song>
}

/**
 * The named/coloured registry behind the plain tag strings songs carry. Names are unique
 * case-insensitively; the cascade onto songs is the IPC layer's job, not this store's.
 */
export interface TagStore {
  list(): Promise<Tag[]>
  create(name: string): Promise<Tag>
  rename(id: string, name: string): Promise<Tag>
  /** Idempotent: removing an id that is not there is a no-op, not an error. */
  remove(id: string): Promise<void>
  getTag(id: string): Promise<Tag | undefined>
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
/** `rng` defaults to `Math.random`; a test pins it to get a predictable tag colour. */
export type CreateTagStore = (dir: string, rng?: () => number) => TagStore
