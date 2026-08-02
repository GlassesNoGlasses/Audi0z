import type { IpcMain } from 'electron'
import { IPC, MEDIA_SCHEME } from '../../shared/ipc'
import type { AddSongRequest, Playlist, Settings, Song, SongDto } from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'
import { NotFoundError } from '../store/errors'
import type { LibraryStore, PlaylistStore, SettingsStore } from '../store/storeTypes'

/**
 * Every request/response channel the library UI needs, wired to the stores.
 *
 * Two rules shape this module:
 *
 *  - **Nothing from the renderer is trusted.** Each handler validates its arguments before a store
 *    sees them; `ipcRenderer.invoke` can be called with anything.
 *  - **Orchestration lives here, not in the stores.** Deleting a song has to trash a file, drop a
 *    library row and cascade into playlists, in that order — putting that sequence in a store
 *    would make the store know about the filesystem and about playlists.
 *
 * No `electron` value import: `trashItem`, `revealInFolder`, `fileExists` and the importer are
 * injected, so the whole surface is testable with fakes in a plain node process.
 */

/** Thrown when the renderer sends something that does not match the `Api` contract. */
export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPayload'
  }
}

export interface LibraryIpcDeps {
  libraryStore: LibraryStore
  playlistStore: PlaylistStore
  settingsStore: SettingsStore
  /** Absolute path of the library's `audio/` directory. */
  audioDir: string
  /**
   * Copies/transcodes a source file into the library and records it (WP3's importer) — the
   * importer calls `libraryStore.add` itself, which is why this handler does not.
   *
   * **The importer MUST be wired with the exact same `LibraryStore` instance passed above.** A
   * store keeps a process-lifetime in-memory copy of `library.json` and never reloads it, so a
   * second `createLibraryStore(dir)` over the same directory would write the import to disk while
   * `library:list` keeps serving its own stale copy for the rest of the session.
   */
  importSong(request: AddSongRequest): Promise<Song>
  /** Moves a file to the OS trash; rejects if the user or the OS refuses. */
  trashItem(absPath: string): Promise<void>
  /**
   * **Must not reject** — an unreadable path is `false`, never a rejection. `library:list` runs one
   * of these per song inside a `Promise.all`, so a single rejection would fail the whole listing,
   * and `library:remove` reads it to decide whether there is anything left to trash. The wired
   * implementation (`wiring.fileExists`) catches everything for exactly this reason.
   */
  fileExists(absPath: string): Promise<boolean>
  revealInFolder(absPath: string): void
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidPayloadError(`${field} must be a non-empty string`)
  }
  return value
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidPayloadError(`${field} must be an array of strings`)
  }
  return value as string[]
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidPayloadError(`${field} must be a boolean`)
  return value
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPayloadError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseAddSongRequest(value: unknown): AddSongRequest {
  const raw = assertRecord(value, 'request')
  return {
    sourcePath: assertNonEmptyString(raw.sourcePath, 'request.sourcePath'),
    title: assertNonEmptyString(raw.title, 'request.title'),
    tags: assertStringArray(raw.tags, 'request.tags'),
    compress: assertBoolean(raw.compress, 'request.compress')
  }
}

function parseSongPatch(value: unknown): Partial<Pick<Song, 'title' | 'tags'>> {
  const raw = assertRecord(value, 'patch')
  return {
    ...(raw.title !== undefined ? { title: assertNonEmptyString(raw.title, 'patch.title') } : {}),
    ...(raw.tags !== undefined ? { tags: assertStringArray(raw.tags, 'patch.tags') } : {})
  }
}

function parsePlaybackOptions(value: unknown): { shuffle?: boolean; repeat?: boolean } {
  const raw = assertRecord(value, 'options')
  return {
    ...(raw.shuffle !== undefined
      ? { shuffle: assertBoolean(raw.shuffle, 'options.shuffle') }
      : {}),
    ...(raw.repeat !== undefined ? { repeat: assertBoolean(raw.repeat, 'options.repeat') } : {})
  }
}

function parseSettingsPatch(value: unknown): Partial<Settings> {
  const raw = assertRecord(value, 'patch')
  const patch: Partial<Settings> = {}
  if (raw.compressByDefault !== undefined) {
    patch.compressByDefault = assertBoolean(raw.compressByDefault, 'patch.compressByDefault')
  }
  if (raw.volume !== undefined) {
    if (typeof raw.volume !== 'number' || !Number.isFinite(raw.volume)) {
      throw new InvalidPayloadError('patch.volume must be a finite number')
    }
    patch.volume = raw.volume
  }
  if (raw.libraryShuffle !== undefined) {
    patch.libraryShuffle = assertBoolean(raw.libraryShuffle, 'patch.libraryShuffle')
  }
  if (raw.libraryRepeat !== undefined) {
    patch.libraryRepeat = assertBoolean(raw.libraryRepeat, 'patch.libraryRepeat')
  }
  return patch
}

export function registerLibraryIpc(ipc: Pick<IpcMain, 'handle'>, deps: LibraryIpcDeps): void {
  /**
   * A `fileName` that resolves outside `audio/` means a hand-edited or corrupted `library.json`;
   * it must never reach `trashItem` or `shell.showItemInFolder`.
   */
  function audioPathOf(song: Song): string {
    const resolved = resolveAudioPath(deps.audioDir, song.fileName)
    if (resolved === null) {
      throw new InvalidPayloadError(`Song "${song.id}" has a fileName outside the audio directory`)
    }
    return resolved
  }

  async function requireSong(rawId: unknown): Promise<Song> {
    const id = assertNonEmptyString(rawId, 'id')
    const song = await deps.libraryStore.getSong(id)
    if (!song) throw new NotFoundError(`No song with id "${id}"`)
    return song
  }

  async function toDto(song: Song): Promise<SongDto> {
    const resolved = resolveAudioPath(deps.audioDir, song.fileName)
    const exists = resolved === null ? false : await deps.fileExists(resolved)
    return { ...song, exists, url: `${MEDIA_SCHEME}://audio/${song.id}` }
  }

  ipc.handle(IPC.library.list, async (): Promise<SongDto[]> => {
    const songs = await deps.libraryStore.list()
    return Promise.all(songs.map(toDto))
  })

  ipc.handle(IPC.library.add, async (_event, request: unknown): Promise<SongDto> => {
    return toDto(await deps.importSong(parseAddSongRequest(request)))
  })

  ipc.handle(IPC.library.update, async (_event, id: unknown, patch: unknown): Promise<SongDto> => {
    const songId = assertNonEmptyString(id, 'id')
    const parsed = parseSongPatch(patch)
    return toDto(await deps.libraryStore.update(songId, parsed))
  })

  /**
   * Delete is trash-first: the library row and the playlist references only go once the file has
   * actually reached the OS trash. If trashing fails (user cancelled, permission denied) the error
   * propagates untouched and the library is exactly as it was.
   *
   * A file that is already gone is skipped rather than trashed. `shell.trashItem` rejects for a
   * path that does not exist, so trashing unconditionally would make the rows the UI marks
   * "File missing" the only ones the user can never remove — leaving `library.json` as the sole
   * way out. The row still goes: that is what the user asked for.
   */
  ipc.handle(IPC.library.remove, async (_event, id: unknown): Promise<void> => {
    const song = await requireSong(id)
    const absPath = audioPathOf(song)
    if (await deps.fileExists(absPath)) await deps.trashItem(absPath)
    await deps.libraryStore.remove(song.id)
    await deps.playlistStore.cascadeRemoveSong(song.id)
  })

  ipc.handle(IPC.library.revealInFolder, async (_event, id: unknown): Promise<void> => {
    const song = await requireSong(id)
    deps.revealInFolder(audioPathOf(song))
  })

  ipc.handle(IPC.playlists.list, (): Promise<Playlist[]> => deps.playlistStore.list())

  ipc.handle(IPC.playlists.create, (_event, name: unknown): Promise<Playlist> =>
    deps.playlistStore.create(assertNonEmptyString(name, 'name'))
  )

  ipc.handle(IPC.playlists.remove, (_event, id: unknown): Promise<void> =>
    deps.playlistStore.remove(assertNonEmptyString(id, 'id'))
  )

  ipc.handle(IPC.playlists.rename, (_event, id: unknown, name: unknown): Promise<Playlist> =>
    deps.playlistStore.rename(assertNonEmptyString(id, 'id'), assertNonEmptyString(name, 'name'))
  )

  ipc.handle(
    IPC.playlists.addSong,
    (_event, playlistId: unknown, songId: unknown): Promise<Playlist> =>
      deps.playlistStore.addSong(
        assertNonEmptyString(playlistId, 'playlistId'),
        assertNonEmptyString(songId, 'songId')
      )
  )

  ipc.handle(
    IPC.playlists.removeSong,
    (_event, playlistId: unknown, songId: unknown): Promise<Playlist> =>
      deps.playlistStore.removeSong(
        assertNonEmptyString(playlistId, 'playlistId'),
        assertNonEmptyString(songId, 'songId')
      )
  )

  ipc.handle(
    IPC.playlists.setPlaybackOptions,
    (_event, id: unknown, options: unknown): Promise<Playlist> =>
      deps.playlistStore.setPlaybackOptions(
        assertNonEmptyString(id, 'id'),
        parsePlaybackOptions(options)
      )
  )

  ipc.handle(IPC.settings.get, (): Promise<Settings> => deps.settingsStore.get())

  ipc.handle(IPC.settings.set, (_event, patch: unknown): Promise<Settings> =>
    deps.settingsStore.set(parseSettingsPatch(patch))
  )
}
