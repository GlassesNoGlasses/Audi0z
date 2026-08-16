import path from 'node:path'
import type { IpcMain } from 'electron'
import { AUDIO_EXTENSIONS } from '../../shared/audioFormats'
import { IPC, MEDIA_SCHEME } from '../../shared/ipc'
import type {
  AddSongRequest,
  CompressResult,
  Playlist,
  Settings,
  Song,
  SongDto,
  Tag
} from '../../shared/types'
import { resolveAudioPath } from '../media/mediaProtocol'
import { isPlayableFile } from '../media/mimeTypes'
import { NotFoundError } from '../store/errors'
import type { LibraryStore, PlaylistStore, SettingsStore, TagStore } from '../store/storeTypes'

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
  /**
   * The tag registry. It knows nothing about songs, so this module owns the cascade — and runs the
   * pass over `libraryStore` *first*, committing here last (the `tags:rename` handler explains
   * why).
   */
  tagStore: TagStore
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
  /**
   * Transcodes an already-imported song to Opus and records the swap (`compressExisting`), wired
   * with the same `LibraryStore` instance for the same reason `importSong` is.
   *
   * `shrank: false` means the re-encode was no smaller and was discarded: nothing was recorded and
   * `song` is the row exactly as it already stood.
   */
  compressSong(id: string): Promise<{ song: Song; shrank: boolean }>
  /**
   * Usually `compressionJobs.waitFor` — the same seam the media protocol takes. Absent means
   * nothing is tracking compressions; an undefined return means this song has none in flight.
   */
  awaitCompression?(id: string): Promise<void> | undefined
  /** Moves a file to the OS trash; rejects if the user or the OS refuses. */
  trashItem(absPath: string): Promise<void>
  /**
   * **Must not reject** — an unreadable path is `false`, never a rejection. `library:remove` reads
   * it to decide whether there is anything left to trash. The wired implementation
   * (`wiring.fileExists`) catches everything for exactly this reason.
   */
  fileExists(absPath: string): Promise<boolean>
  /**
   * **Must not reject** — `null` means "could not measure" (missing, unreadable, not a file).
   * `library:list` runs one of these per song inside a `Promise.all`, so a single rejection would
   * fail the whole listing. `0` is a real size and must stay distinct from `null`.
   */
  fileSize(absPath: string): Promise<number | null>
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

/**
 * The picker keeps an "All files" escape hatch — a correctly encoded file with an odd name is the
 * user's to add — so this is where a file the app could never play is turned away. Importing one
 * costs a copy of the whole file and mints a song that is silent forever and reported as missing;
 * refusing costs a sentence the renderer already knows how to show.
 *
 * The downloader calls `importFile` directly and never comes through this handler, so URL ingest
 * is untouched by this check.
 */
function assertPlayableSource(sourcePath: string): void {
  if (!isPlayableFile(sourcePath)) {
    throw new InvalidPayloadError(
      `Cannot play "${path.basename(sourcePath)}" — supported formats are ${AUDIO_EXTENSIONS.map(
        (ext) => ext.toUpperCase()
      ).join(', ')}.`
    )
  }
}

/** A playing time has to be a real, positive number of seconds — 0, NaN and Infinity are bugs. */
function assertDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidPayloadError(`${field} must be a positive finite number`)
  }
  return value
}

function parseSongPatch(value: unknown): Partial<Pick<Song, 'title' | 'tags' | 'durationSec'>> {
  const raw = assertRecord(value, 'patch')
  return {
    ...(raw.title !== undefined ? { title: assertNonEmptyString(raw.title, 'patch.title') } : {}),
    ...(raw.tags !== undefined ? { tags: assertStringArray(raw.tags, 'patch.tags') } : {}),
    ...(raw.durationSec !== undefined
      ? { durationSec: assertDuration(raw.durationSec, 'patch.durationSec') }
      : {})
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

/**
 * A whole playlist order in one payload. Only the shape is checked here — whether these are the
 * right ids is the store's call, and it refuses anything that does not name every playlist once.
 */
function parsePlaylistOrder(value: unknown): string[] {
  const ids = assertStringArray(value, 'orderedIds')
  for (const id of ids) assertNonEmptyString(id, 'orderedIds entry')
  return ids
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

  /**
   * The id is encoded because `mediaProtocol` decodes it: ids are uuids in practice, but
   * `library.json` is hand-editable, and the two halves have to agree whatever is in there.
   */
  async function toDto(song: Song): Promise<SongDto> {
    // The same courtesy the media protocol pays. A dto built while this song's file is mid-swap
    // would measure the path the compressor is about to remove and report a freshly compressed
    // song as missing — and the renderer keeps that verdict for the whole session, since nothing
    // re-derives `exists` on its own. Wait the swap out and read the record fresh; when nothing is
    // in flight this is not even a microtask.
    const settled = deps.awaitCompression?.(song.id)
    if (settled) {
      await settled
      const fresh = await deps.libraryStore.getSong(song.id)
      if (fresh) song = fresh
    }
    const resolved = resolveAudioPath(deps.audioDir, song.fileName)
    // One measurement answers both questions: a size that came back *is* the proof of existence,
    // so there is no second filesystem call and no way for the two fields to disagree. A 0-byte
    // file therefore reads as present, which is what it is.
    const size = resolved === null ? null : await deps.fileSize(resolved)
    return {
      ...song,
      exists: size !== null,
      url: `${MEDIA_SCHEME}://audio/${encodeURIComponent(song.id)}`,
      sizeBytes: size
    }
  }

  ipc.handle(IPC.library.list, async (): Promise<SongDto[]> => {
    const songs = await deps.libraryStore.list()
    return Promise.all(songs.map(toDto))
  })

  ipc.handle(IPC.library.add, async (_event, request: unknown): Promise<SongDto> => {
    const parsed = parseAddSongRequest(request)
    assertPlayableSource(parsed.sourcePath)
    return toDto(await deps.importSong(parsed))
  })

  ipc.handle(IPC.library.update, async (_event, id: unknown, patch: unknown): Promise<SongDto> => {
    const songId = assertNonEmptyString(id, 'id')
    const parsed = parseSongPatch(patch)
    return toDto(await deps.libraryStore.update(songId, parsed))
  })

  /** The backfill's flush: every entry validated up front, then one store pass, one persist. */
  ipc.handle(IPC.library.updateDurations, async (_event, entries: unknown): Promise<SongDto[]> => {
    if (!Array.isArray(entries)) throw new InvalidPayloadError('entries must be an array')
    const parsed = entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new InvalidPayloadError('each entry must be an object')
      }
      const candidate = entry as Record<string, unknown>
      return {
        id: assertNonEmptyString(candidate['id'], 'id'),
        durationSec: assertDuration(candidate['durationSec'], 'durationSec')
      }
    })
    const updated = await deps.libraryStore.updateDurations(parsed)
    return Promise.all(updated.map((song) => toDto(song)))
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

  /**
   * The compressor records the swap itself (`replaceFile`), so this handler only re-derives the
   * DTO — and it re-measures the file, which is the point: the new size is what the UI shows.
   *
   * `shrank` rides along untouched. A re-encode that was no smaller is not an error — there is
   * simply nothing to report but a song that did not change — and only the renderer can say that
   * out loud.
   */
  ipc.handle(IPC.library.compress, async (_event, id: unknown): Promise<CompressResult> => {
    const songId = assertNonEmptyString(id, 'id')
    const { song, shrank } = await deps.compressSong(songId)
    return { song: await toDto(song), shrank }
  })

  /** The folder itself, not a song inside it — so there is nothing to look up and nothing to trust. */
  ipc.handle(IPC.library.showFolder, async (): Promise<void> => {
    deps.revealInFolder(deps.audioDir)
  })

  ipc.handle(IPC.tags.list, (): Promise<Tag[]> => deps.tagStore.list())

  ipc.handle(IPC.tags.create, (_event, name: unknown): Promise<Tag> =>
    deps.tagStore.create(assertNonEmptyString(name, 'name'))
  )

  /**
   * Songs first, registry last.
   *
   * `library.json` and `tags.json` are two separate atomic writes, and no filesystem lands two
   * renames as one commit — so the window between them cannot be closed by any amount of write
   * plumbing, only pointed somewhere harmless. The order is what decides *which* half a crash
   * strands, and only one of the two halves is benign.
   *
   * The tags dialog draws the registry and nothing else, so committing it first would leave the
   * app reporting a rename that succeeded while every song still carried the dead string — a grey,
   * unreachable chip, and no reason for the user to retry. Committing it last leaves the tag under
   * its old name: the operation plainly did not take, which is what the user will believe, and
   * repeating the identical gesture *is* the repair — the library pass is a no-op once the songs
   * have already moved.
   *
   * `resolveRename` writes nothing. It is what still refuses a clashing name before a single song
   * moves, and it answers with the *trimmed* name, so the songs and the registry can only agree on
   * spelling. The cascade matches on the name the tag had before the rename, which is why the old
   * tag is read up front.
   */
  ipc.handle(IPC.tags.rename, async (_event, id: unknown, name: unknown): Promise<Tag> => {
    const tagId = assertNonEmptyString(id, 'id')
    const newName = assertNonEmptyString(name, 'name')
    const existing = await deps.tagStore.getTag(tagId)
    if (!existing) throw new NotFoundError(`No tag with id "${tagId}"`)

    const resolved = await deps.tagStore.resolveRename(tagId, newName)
    await deps.libraryStore.renameTag(existing.name, resolved)
    return deps.tagStore.rename(tagId, resolved)
  })

  /**
   * Songs first, registry last, for the reason `tags:rename` spells out. What an interrupted delete
   * leaves behind is an ordinary unused registry tag — indistinguishable from one just created, and
   * with a Delete button next to it — rather than an orphan string on every song that no dialog in
   * the app can reach.
   *
   * Removing a tag that is not in the registry is still a no-op: the end state is what was asked
   * for.
   */
  ipc.handle(IPC.tags.remove, async (_event, id: unknown): Promise<void> => {
    const tagId = assertNonEmptyString(id, 'id')
    const existing = await deps.tagStore.getTag(tagId)
    if (!existing) return

    await deps.libraryStore.removeTag(existing.name)
    await deps.tagStore.remove(tagId)
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

  ipc.handle(IPC.playlists.reorder, (_event, orderedIds: unknown): Promise<Playlist[]> =>
    deps.playlistStore.reorder(parsePlaylistOrder(orderedIds))
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
