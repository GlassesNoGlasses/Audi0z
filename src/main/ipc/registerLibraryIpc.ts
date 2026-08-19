import path from 'node:path'
import type { IpcMain } from 'electron'
import { AUDIO_FORMAT_LABELS } from '../../shared/audioFormats'
import { IPC } from '../../shared/ipc'
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
import { toSongDto } from './songDto'

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
  tagStore: TagStore
  audioDir: string // absolute
  importSong(request: AddSongRequest): Promise<Song>
  compressSong(id: string): Promise<{ song: Song; shrank: boolean }>
  /**
   * Usually `compressionJobs.waitFor` — the same seam the media protocol takes. Absent means
   * nothing is tracking compressions; an undefined return means this song has none in flight.
   */
  awaitCompression?(id: string): Promise<void> | undefined
  /** Moves a file to the OS trash; rejects if the user or the OS refuses. */
  trashItem(absPath: string): Promise<void>
  fileExists(absPath: string): Promise<boolean>
  /** **Must not reject** — `null` means "could not measure" (missing, unreadable, not a file).*/
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

// file extension check
function assertPlayableSource(sourcePath: string): void {
  if (!isPlayableFile(sourcePath)) {
    throw new InvalidPayloadError(
      `Cannot play "${path.basename(sourcePath)}" — supported formats are ${AUDIO_FORMAT_LABELS.join(
        ', '
      )}.`
    )
  }
}

// > 0 seconds
function assertDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidPayloadError(`${field} must be a positive finite number`)
  }
  return value
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
   * `compressExisting` renames the new file into place and only then removes the old one, so a
   * projection that raced the swap would measure a path that is already gone and report a song that
   * compressed perfectly as missing. Settle the swap and re-read the record, then project.
   */
  async function toDto(song: Song): Promise<SongDto> {
    const settled = deps.awaitCompression?.(song.id)
    if (settled) {
      await settled
      const fresh = await deps.libraryStore.getSong(song.id)
      if (fresh) song = fresh
    }
    return toSongDto(song, deps)
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

  /** The backfill's flush: update songs with their durations periodically in the back */
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

  // attempts to remove a song from the libray. If OS rejects, song remains
  ipc.handle(IPC.library.remove, async (_event, id: unknown): Promise<void> => {
    const song = await requireSong(id)
    const absPath = audioPathOf(song)
    if (await deps.fileExists(absPath)) await deps.trashItem(absPath)
    await deps.libraryStore.remove(song.id)
    await deps.playlistStore.cascadeRemoveSong(song.id)
  })

  ipc.handle(IPC.library.compress, async (_event, id: unknown): Promise<CompressResult> => {
    const songId = assertNonEmptyString(id, 'id')
    const { song, shrank } = await deps.compressSong(songId)
    return { song: await toDto(song), shrank }
  })

  /** The library audio folder itself; for settings & transparency */
  ipc.handle(IPC.library.showFolder, async (): Promise<void> => {
    deps.revealInFolder(deps.audioDir)
  })

  ipc.handle(IPC.tags.list, (): Promise<Tag[]> => deps.tagStore.list())

  ipc.handle(IPC.tags.create, (_event, name: unknown): Promise<Tag> =>
    deps.tagStore.create(assertNonEmptyString(name, 'name'))
  )
  ipc.handle(IPC.tags.rename, async (_event, id: unknown, name: unknown): Promise<Tag> => {
    const tagId = assertNonEmptyString(id, 'id')
    const newName = assertNonEmptyString(name, 'name')
    const existing = await deps.tagStore.getTag(tagId)
    if (!existing) throw new NotFoundError(`No tag with id "${tagId}"`)

    const resolved = await deps.tagStore.resolveRename(tagId, newName)
    await deps.libraryStore.renameTag(existing.name, resolved)
    return deps.tagStore.rename(tagId, resolved)
  })

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
