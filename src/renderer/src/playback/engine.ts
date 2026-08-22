/** The playback rulebook, as pure functions: state in, state out. */
import { currentIndex, isPlayed } from './selectors'
import type { NextSelection, PlaybackAction, PlaybackState, Rng } from './types'

/** How many played ids `history` keeps for `transport/prev`; the oldest fall off the front. */
const HISTORY_LIMIT = 100

type PlayedMap = Readonly<Record<string, true>>

/** The only place `Math.random` may appear. */
export const defaultRng: Rng = (upperExclusive) => Math.floor(Math.random() * upperExclusive)

export function initialPlaybackState(): PlaybackState {
  return {
    queueId: null,
    order: [],
    currentId: null,
    played: {},
    history: [],
    shuffle: false,
    repeat: false,
    isPlaying: false,
    playToken: 0
  }
}

/** Next song, and whether the played flags reset first. Ignores `repeat`. */
export function chooseNext(state: PlaybackState, rng: Rng): NextSelection {
  if (state.order.length === 0) return { songId: null, resetPlayed: false }
  return state.shuffle ? chooseShuffled(state, rng) : chooseSequential(state)
}

/** Next index in queue order; wrapping past the end resets the played flags. */
function chooseSequential(state: PlaybackState): NextSelection {
  const index = currentIndex(state)
  if (index === -1) return { songId: state.order[0], resetPlayed: false }
  if (index === state.order.length - 1) return { songId: state.order[0], resetPlayed: true }
  return { songId: state.order[index + 1], resetPlayed: false }
}

/** A random unplayed song; once all are played the flags reset and the current is excluded. */
function chooseShuffled(state: PlaybackState, rng: Rng): NextSelection {
  const unplayed = state.order.filter((id) => !isPlayed(state, id))
  if (unplayed.length === 1) return { songId: unplayed[0], resetPlayed: false }
  if (unplayed.length > 1) return { songId: unplayed[rng(unplayed.length)], resetPlayed: false }

  const candidates = state.order.filter((id) => id !== state.currentId)
  if (candidates.length === 0) return { songId: state.order[0], resetPlayed: true }
  return { songId: candidates[rng(candidates.length)], resetPlayed: true }
}

/** INVARIANT: a result with a `currentId` has it marked played — reset-then-mark on wrap. */
export function playbackReducer(
  state: PlaybackState,
  action: PlaybackAction,
  rng: Rng
): PlaybackState {
  switch (action.type) {
    case 'queue/selected': {
      // Switching stops playback; played flags and history belong to the queue being left.
      const switched: PlaybackState = {
        ...state,
        queueId: action.queueId,
        order: [...action.order],
        shuffle: action.shuffle,
        repeat: action.repeat,
        currentId: null,
        isPlaying: false,
        played: {},
        history: []
      }
      // A carried `startSongId` starts the new queue fresh from that song.
      if (action.startSongId === undefined) return switched
      return startSong(switched, action.startSongId, true)
    }
    case 'queue/orderChanged':
      return changeOrder(state, action.order)
    case 'song/selected':
      return startSong(state, action.songId, true)
    case 'song/ended':
      return state.repeat ? restartCurrent(state) : advance(state, rng)
    case 'transport/next':
      // Ignores repeat, and leaves it on: the button advances, it does not clear repeat.
      return advance(state, rng)
    case 'transport/prev':
      return goToPrevious(state)
    case 'transport/play':
      return { ...state, isPlaying: true }
    case 'transport/pause':
      return { ...state, isPlaying: false }
    case 'transport/togglePlay':
      return togglePlay(state)
    case 'transport/setShuffle':
      return { ...state, shuffle: action.value }
    case 'transport/setRepeat':
      return { ...state, repeat: action.value }
    case 'library/songsRemoved':
      return removeSongs(state, action.songIds)
    case 'playlists/removed':
      return removePlaylist(state, action.playlistId)
  }
}

/** `playbackReducer` with the rng baked in, ready for `useReducer`. */
export function createPlaybackReducer(
  rng: Rng = defaultRng
): (state: PlaybackState, action: PlaybackAction) => PlaybackState {
  return (state, action) => playbackReducer(state, action, rng)
}

/** Starts `songId`: marks it played, bumps the play token, appends to history. */
function startSong(state: PlaybackState, songId: string, resetPlayed: boolean): PlaybackState {
  // No queue selected: nothing may become current.
  if (state.queueId === null) return state

  const kept = resetPlayed ? {} : state.played
  return {
    ...state,
    currentId: songId,
    isPlaying: true,
    playToken: state.playToken + 1,
    played: { ...kept, [songId]: true },
    // Restarting the song that is already current is not a new entry.
    history: songId === state.currentId ? state.history : pushHistory(state.history, songId)
  }
}

/** Replays the current song: no flag, history or selection changes — just a new play token. */
function restartCurrent(state: PlaybackState): PlaybackState {
  return { ...state, isPlaying: true, playToken: state.playToken + 1 }
}

function advance(state: PlaybackState, rng: Rng): PlaybackState {
  const finished = markCurrentPlayed(state)
  const { songId, resetPlayed } = chooseNext(finished, rng)
  if (songId === null) return { ...finished, currentId: null, isPlaying: false }
  return startSong(finished, songId, resetPlayed)
}

/** Steps back one history entry, dropping the current; without an earlier entry it restarts. */
function goToPrevious(state: PlaybackState): PlaybackState {
  if (state.currentId === null) return state

  const at = state.history.lastIndexOf(state.currentId)
  if (at <= 0) return restartCurrent(state)

  const previousId = state.history[at - 1]
  return {
    ...state,
    currentId: previousId,
    isPlaying: true,
    playToken: state.playToken + 1,
    history: state.history.slice(0, at),
    played: { ...state.played, [previousId]: true }
  }
}

/** Play/pause — or, with nothing cued up yet, start the queue like a manual click. */
function togglePlay(state: PlaybackState): PlaybackState {
  if (state.currentId !== null) return { ...state, isPlaying: !state.isPlaying }
  if (state.order.length === 0) return state
  return startSong(state, state.order[0], true)
}

function changeOrder(state: PlaybackState, order: readonly string[]): PlaybackState {
  const next = [...order]
  const kept = new Set(next)
  const currentSurvives = state.currentId !== null && kept.has(state.currentId)

  return {
    ...state,
    order: next,
    played: filterPlayed(state.played, (id) => kept.has(id)),
    currentId: currentSurvives ? state.currentId : null,
    isPlaying: currentSurvives && state.isPlaying
  }
}

function removeSongs(state: PlaybackState, songIds: readonly string[]): PlaybackState {
  const removed = new Set(songIds)
  const survives = (id: string): boolean => !removed.has(id)
  const currentRemoved = state.currentId !== null && removed.has(state.currentId)

  return {
    ...state,
    order: state.order.filter(survives),
    history: state.history.filter(survives),
    played: filterPlayed(state.played, survives),
    currentId: currentRemoved ? null : state.currentId,
    isPlaying: currentRemoved ? false : state.isPlaying
  }
}

/** If the deleted playlist owns the queue, the queue is cleared; any other is not playback's. */
function removePlaylist(state: PlaybackState, playlistId: string): PlaybackState {
  if (state.queueId !== playlistId) return state

  return {
    ...state,
    queueId: null,
    order: [],
    currentId: null,
    played: {},
    history: [],
    isPlaying: false
  }
}

function markCurrentPlayed(state: PlaybackState): PlaybackState {
  if (state.currentId === null) return state
  return {
    ...state,
    played: { ...state.played, [state.currentId]: true }
  }
}

function filterPlayed(map: PlayedMap, keep: (id: string) => boolean): PlayedMap {
  const next: Record<string, true> = {}
  for (const id of Object.keys(map)) {
    if (keep(id)) next[id] = true
  }
  return next
}

function pushHistory(history: readonly string[], songId: string): readonly string[] {
  const next = [...history, songId]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}
