import type { Playlist, Settings, SongDto } from '../../../shared/types'
import { createPlaybackReducer, defaultRng, initialPlaybackState } from '../playback/engine'
import type { PlaybackAction, PlaybackState, Rng } from '../playback/types'

/**
 * The renderer's single state tree: library data, view state, and the playback engine's state
 * nested under `playback`.
 *
 * Playback actions are forwarded to the (frozen, pure) engine untouched — this reducer only adds
 * the things the engine has no business knowing about: the songs themselves, dialogs and toasts.
 * `library/songsRemoved` is the one action both halves care about.
 */

export type View = { kind: 'library' } | { kind: 'playlist'; id: string }

export interface Toast {
  id: number
  message: string
}

/** What a confirmation dialog will do once confirmed. Data, not a callback, so state stays plain. */
export type ConfirmIntent =
  { kind: 'deleteSong'; songId: string } | { kind: 'deletePlaylist'; playlistId: string }

/** Where an add is coming from: files already chosen (picker or drop), or a URL to fetch. */
export type AddSource = { kind: 'files'; paths: string[] } | { kind: 'url' }

export type Dialog =
  | { kind: 'add'; source: AddSource }
  | { kind: 'edit'; songId: string }
  | { kind: 'settings' }
  | { kind: 'confirm'; message: string; confirmLabel: string; intent: ConfirmIntent }

export interface AppState {
  songs: SongDto[]
  playlists: Playlist[]
  settings: Settings
  view: View
  query: string
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
  | { type: 'library/songUpdated'; song: SongDto }
  | { type: 'library/songMissing'; songId: string }
  | { type: 'playlists/loaded'; playlists: Playlist[] }
  | { type: 'playlists/upserted'; playlist: Playlist }
  | { type: 'playlists/removed'; playlistId: string }
  | { type: 'playlist/expandToggled'; playlistId: string }
  | { type: 'settings/updated'; settings: Settings }
  | { type: 'view/selected'; view: View }
  | { type: 'query/changed'; query: string }
  | { type: 'dialog/opened'; dialog: Dialog }
  | { type: 'dialog/closed' }
  | { type: 'toast/pushed'; message: string }
  | { type: 'toast/dismissed'; id: number }

/**
 * Renderer-side defaults, kept in step with `settingsStore`'s. Duplicated rather than imported:
 * the renderer must not reach into the main process, and this is only what is shown for the
 * handful of milliseconds before `settings.get()` answers.
 */
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
    settings: { ...FALLBACK_SETTINGS },
    view: { kind: 'library' },
    query: '',
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
  'library/songsRemoved': true
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
      // Identity preserved when nothing moved, so React can skip the re-render.
      return nextPlayback === state.playback ? state : { ...state, playback: nextPlayback }
    }

    switch (action.type) {
      case 'library/loaded':
        return { ...state, songs: action.songs }
      case 'library/songUpdated':
        return {
          ...state,
          songs: state.songs.map((song) => (song.id === action.song.id ? action.song : song))
        }
      case 'library/songMissing':
        return {
          ...state,
          songs: state.songs.map((song) =>
            song.id === action.songId ? { ...song, exists: false } : song
          )
        }
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
      case 'playlists/removed':
        return {
          ...state,
          playlists: state.playlists.filter((p) => p.id !== action.playlistId),
          expandedPlaylists: toggleOff(state.expandedPlaylists, action.playlistId)
        }
      case 'playlist/expandToggled':
        return { ...state, expandedPlaylists: toggle(state.expandedPlaylists, action.playlistId) }
      case 'settings/updated':
        return { ...state, settings: action.settings }
      case 'view/selected':
        return { ...state, view: action.view }
      case 'query/changed':
        return { ...state, query: action.query }
      case 'dialog/opened':
        return { ...state, dialog: action.dialog }
      case 'dialog/closed':
        return state.dialog === null ? state : { ...state, dialog: null }
      // Every report gets its own line. A failure often produces two — main's own on the error
      // channel and the rejected `invoke`, which the renderer may have added context to — and only
      // the caller knows which one carries the useful half, so neither is thrown away. It also
      // means a failure that happens twice is reported twice, instead of looking ignored.
      case 'toast/pushed':
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
