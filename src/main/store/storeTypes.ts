import type { Playlist, Settings, Song, Tag } from '../../shared/types'

export interface LibraryStore {
  list(): Promise<Song[]>
  getSong(id: string): Promise<Song | undefined>
  add(song: Song): Promise<Song>
  update(id: string, patch: Partial<Pick<Song, 'title' | 'tags'>>): Promise<Song>
  updateDurations(entries: ReadonlyArray<{ id: string; durationSec: number }>): Promise<Song[]>
  reorder(orderedIds: string[]): Promise<Song[]>
  remove(id: string): Promise<void>
  renameTag(oldName: string, newName: string): Promise<void>
  removeTag(name: string): Promise<void>
  replaceFile(id: string, fileName: string, compressed: boolean): Promise<Song>
}

export interface TagStore {
  list(): Promise<Tag[]>
  create(name: string): Promise<Tag>
  rename(id: string, name: string): Promise<Tag>
  resolveRename(id: string, name: string): Promise<string>
  remove(id: string): Promise<void>
  getTag(id: string): Promise<Tag | undefined>
}

export interface PlaylistStore {
  list(): Promise<Playlist[]>
  create(name: string): Promise<Playlist>
  rename(id: string, name: string): Promise<Playlist>
  remove(id: string): Promise<void>
  reorder(orderedIds: string[]): Promise<Playlist[]>
  addSong(playlistId: string, songId: string): Promise<Playlist>
  removeSong(playlistId: string, songId: string): Promise<Playlist>
  setPlaybackOptions(id: string, opts: { shuffle?: boolean; repeat?: boolean }): Promise<Playlist>
  cascadeRemoveSong(songId: string): Promise<void>
  reorderSongs(playlistId: string, songIds: string[]): Promise<Playlist>
}

export interface SettingsStore {
  get(): Promise<Settings>
  set(patch: Partial<Settings>): Promise<Settings>
}

export type CreateLibraryStore = (dir: string) => LibraryStore
export type CreatePlaylistStore = (dir: string) => PlaylistStore
export type CreateSettingsStore = (dir: string) => SettingsStore
export type CreateTagStore = (dir: string, rng?: () => number) => TagStore // rng -> colour hex
