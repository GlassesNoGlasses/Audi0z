import type { Playlist, Settings, SongDto, Tag } from '../../../shared/types'
import { createPlaybackReducer, defaultRng, initialPlaybackState } from '../playback/engine'
import type { PlaybackAction, PlaybackState, Rng } from '../playback/types'

export type View = { kind: 'library' } | { kind: 'playlist'; id: string }

export interface Toast {
  id: number
  message: string
}

export type ConfirmIntent =
  { kind: 'deleteSong'; songId: string } | { kind: 'deletePlaylist'; playlistId: string }

/** Where an add is coming from: files already chosen with the picker, or a URL to fetch. */
export type AddSource = { kind: 'files'; paths: string[] } | { kind: 'url' }

export enum SortType {
  CUSTOM = 'Custom Order',
  TITLE = 'Title',
  DATEADDED = 'Date Added',
  DURATION = 'Duration',
  SIZE = 'Size'
}

export enum SortDirection {
  ASC,
  DESC
}

/** How the view is ordered; CUSTOM is the stored order itself. */
export type SortMode = {
  type: SortType
  direction: SortDirection
}

export type Dialog =
  | { kind: 'add'; source: AddSource }
  | { kind: 'edit'; songId: string }
  | { kind: 'settings' }
  | { kind: 'tags' }
  | { kind: 'addToPlaylist'; playlistId: string }
  | { kind: 'confirm'; message: string; confirmLabel: string; intent: ConfirmIntent }

export interface AppState {
  songs: SongDto[]
  playlists: Playlist[]
  tags: Tag[]
  settings: Settings
  view: View
  query: string
  /** Global and session-only, like the query: never persisted. */
  sort: SortMode
  expandedPlaylists: ReadonlySet<string>
  dialog: Dialog | null
  toasts: Toast[]
  /** Monotonic, so a dismissed toast's id is never reused while a later one is still up. */
  nextToastId: number
  playback: PlaybackState
}

export type AppAction =
  | PlaybackAction
  | { type: 'library/loaded'; songs: SongDto[] }
  | { type: 'library/reordered'; order: string[] }
  | { type: 'library/songUpdated'; song: SongDto }
  /** Several songs in one dispatch, so a batched write costs one re-render rather than one each. */
  | { type: 'library/songsUpdated'; songs: SongDto[] }
  | { type: 'library/songMissing'; songId: string }
  | { type: 'tags/loaded'; tags: Tag[] }
  | { type: 'playlists/loaded'; playlists: Playlist[] }
  | { type: 'playlists/upserted'; playlist: Playlist }
  // `playlists/removed` arrives as a `PlaybackAction`: the queue may be the playlist being deleted.
  | { type: 'playlist/expandToggled'; playlistId: string }
  | { type: 'settings/updated'; settings: Settings }
  | { type: 'view/selected'; view: View }
  | { type: 'query/changed'; query: string }
  | { type: 'sort/changed'; sort: SortMode }
  | { type: 'dialog/opened'; dialog: Dialog }
  | { type: 'dialog/closed' }
  | { type: 'toast/pushed'; message: string }
  | { type: 'toast/dismissed'; id: number }

/** Renderer-side mirror of `settingsStore`'s defaults, shown until `settings.get()` answers. */
export const FALLBACK_SETTINGS: Settings = {
  version: 1,
  compressByDefault: false,
  volume: 1,
  libraryShuffle: false,
  libraryRepeat: false
}

export function initialAppState(): AppState {
  return {
    songs: [],
    playlists: [],
    tags: [],
    settings: { ...FALLBACK_SETTINGS },
    view: { kind: 'library' },
    query: '',
    sort: { type: SortType.CUSTOM, direction: SortDirection.ASC },
    expandedPlaylists: new Set(),
    dialog: null,
    toasts: [],
    nextToastId: 1,
    playback: initialPlaybackState()
  }
}

/** Exhaustive by construction: a new `PlaybackAction` member fails to compile until it is listed. */
const PLAYBACK_ACTION_TYPES: Record<PlaybackAction['type'], true> = {
  'queue/selected': true,
  'queue/orderChanged': true,
  'song/selected': true,
  'song/ended': true,
  'transport/next': true,
  'transport/prev': true,
  'transport/play': true,
  'transport/pause': true,
  'transport/togglePlay': true,
  'transport/setShuffle': true,
  'transport/setRepeat': true,
  'library/songsRemoved': true,
  'playlists/removed': true
}

function isPlaybackAction(action: AppAction): action is PlaybackAction {
  return Object.hasOwn(PLAYBACK_ACTION_TYPES, action.type)
}

function toggle(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

export function createAppReducer(
  rng: Rng = defaultRng
): (state: AppState, action: AppAction) => AppState {
  const playback = createPlaybackReducer(rng)

  return function appReducer(state: AppState, action: AppAction): AppState {
    if (isPlaybackAction(action)) {
      const nextPlayback = playback(state.playback, action)
      if (action.type === 'library/songsRemoved') {
        const removed = new Set(action.songIds)
        return {
          ...state,
          songs: state.songs.filter((song) => !removed.has(song.id)),
          playback: nextPlayback
        }
      }
      if (action.type === 'playlists/removed') {
        return {
          ...state,
          playlists: state.playlists.filter((p) => p.id !== action.playlistId),
          expandedPlaylists: toggleOff(state.expandedPlaylists, action.playlistId),
          playback: nextPlayback
        }
      }
      // Identity preserved when nothing moved, so React can skip the re-render.
      return nextPlayback === state.playback ? state : { ...state, playback: nextPlayback }
    }

    switch (action.type) {
      case 'library/loaded':
        return { ...state, songs: action.songs }
      case 'library/reordered': {
        const byId = new Map(state.songs.map((song) => [song.id, song]))
        const next: SongDto[] = []
        for (const id of action.order) {
          const found = byId.get(id)
          if (found) {
            next.push(found)
            byId.delete(id)
          }
        }
        // Anything the order failed to name keeps a place at the end rather than vanishing.
        for (const song of state.songs) if (byId.has(song.id)) next.push(song)
        return { ...state, songs: next }
      }
      case 'library/songUpdated':
        return {
          ...state,
          songs: state.songs.map((song) => (song.id === action.song.id ? action.song : song))
        }
      case 'library/songsUpdated': {
        const byId = new Map(action.songs.map((song) => [song.id, song]))
        return { ...state, songs: state.songs.map((song) => byId.get(song.id) ?? song) }
      }
      case 'library/songMissing':
        return {
          ...state,
          songs: state.songs.map((song) =>
            // DTO invariant: `sizeBytes` is null exactly when the file is gone.
            song.id === action.songId ? { ...song, exists: false, sizeBytes: null } : song
          )
        }
      case 'tags/loaded':
        return { ...state, tags: action.tags }
      case 'playlists/loaded':
        return { ...state, playlists: action.playlists }
      case 'playlists/upserted': {
        const known = state.playlists.some((p) => p.id === action.playlist.id)
        return {
          ...state,
          playlists: known
            ? state.playlists.map((p) => (p.id === action.playlist.id ? action.playlist : p))
            : [...state.playlists, action.playlist]
        }
      }
      case 'playlist/expandToggled':
        return { ...state, expandedPlaylists: toggle(state.expandedPlaylists, action.playlistId) }
      case 'settings/updated':
        return { ...state, settings: action.settings }
      case 'view/selected':
        return { ...state, view: action.view }
      case 'query/changed':
        return { ...state, query: action.query }
      case 'sort/changed':
        return { ...state, sort: action.sort }
      case 'dialog/opened':
        return { ...state, dialog: action.dialog }
      case 'dialog/closed':
        return state.dialog === null ? state : { ...state, dialog: null }
      // A message identical to one still on screen is dropped; dismissed ones can say it again.
      case 'toast/pushed':
        if (state.toasts.some((toast) => toast.message === action.message)) return state
        return {
          ...state,
          toasts: [...state.toasts, { id: state.nextToastId, message: action.message }],
          nextToastId: state.nextToastId + 1
        }
      case 'toast/dismissed':
        return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) }
    }
  }
}

function toggleOff(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!set.has(value)) return set
  const next = new Set(set)
  next.delete(value)
  return next
}
