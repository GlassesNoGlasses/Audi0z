/**
 * The playback rulebook, as pure functions: state in, state out. No React, no DOM, no timers, and
 * no randomness beyond the injected `Rng`.
 */
import { isPlayed, playedInCurrentQueue } from './selectors'
import type { NextSelection, PlaybackAction, PlaybackState, Rng } from './types'

/** How many played ids `history` keeps for `transport/prev`; the oldest fall off the front. */
const HISTORY_LIMIT = 100

type PlayedByQueue = PlaybackState['playedByQueue']
type PlayedMap = Readonly<Record<string, true>>

/** The only place `Math.random` may appear. */
export const defaultRng: Rng = (upperExclusive) => Math.floor(Math.random() * upperExclusive)

export function initialPlaybackState(): PlaybackState {
  return {
    queueId: null,
    order: [],
    currentId: null,
    playedByQueue: {},
    history: [],
    shuffle: false,
    repeat: false,
    isPlaying: false,
    playToken: 0
  }
}

/**
 * Which song follows the current one, and whether the current queue's played flags must be reset
 * first. Deliberately ignorant of `repeat` — repeating a song never asks for a next one.
 */
export function chooseNext(state: PlaybackState, rng: Rng): NextSelection {
  if (state.order.length === 0) return { songId: null, resetPlayed: false }
  return state.shuffle ? chooseShuffled(state, rng) : chooseSequential(state)
}

/** Next index in queue order; wrapping past the end resets the played flags. */
function chooseSequential(state: PlaybackState): NextSelection {
  const index = state.currentId === null ? -1 : state.order.indexOf(state.currentId)
  if (index === -1) return { songId: state.order[0], resetPlayed: false }
  if (index === state.order.length - 1) return { songId: state.order[0], resetPlayed: true }
  return { songId: state.order[index + 1], resetPlayed: false }
}

/**
 * A random unplayed song. Once every song is played the flags reset, and the pick excludes the
 * current song so it cannot immediately repeat (impossible in a single-song queue).
 */
function chooseShuffled(state: PlaybackState, rng: Rng): NextSelection {
  const unplayed = state.order.filter((id) => !isPlayed(state, id))
  if (unplayed.length === 1) return { songId: unplayed[0], resetPlayed: false }
  if (unplayed.length > 1) return { songId: unplayed[rng(unplayed.length)], resetPlayed: false }

  const candidates = state.order.filter((id) => id !== state.currentId)
  if (candidates.length === 0) return { songId: state.order[0], resetPlayed: true }
  return { songId: candidates[rng(candidates.length)], resetPlayed: true }
}

/**
 * The rulebook. Every action returns a fresh state; the input is never mutated.
 *
 * INVARIANT: whenever the result has a `currentId`, that id is marked played in the current
 * queue. Transitions that pick a new song on wrap or exhaustion clear the queue's map FIRST and
 * then mark the new pick.
 */
export function playbackReducer(
  state: PlaybackState,
  action: PlaybackAction,
  rng: Rng
): PlaybackState {
  switch (action.type) {
    case 'queue/selected':
      // Switching context stops playback outright — no surprise cross-fade between queues. The
      // outgoing queue's played flags stay in `playedByQueue`, ready for when it is selected again.
      return {
        ...state,
        queueId: action.queueId,
        order: [...action.order],
        shuffle: action.shuffle,
        repeat: action.repeat,
        currentId: null,
        isPlaying: false,
        history: []
      }
    case 'queue/orderChanged':
      return changeOrder(state, action.order)
    case 'song/selected':
      return startSong(state, action.songId, true)
    case 'song/ended':
      return state.repeat ? restartCurrent(state) : advance(state, rng)
    case 'transport/next':
      // Same as a song ending, except repeat is ignored — and left untouched (the button advances,
      // it does not turn repeat off).
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
  }
}

/** `playbackReducer` with the rng baked in, ready for `useReducer`. */
export function createPlaybackReducer(
  rng: Rng = defaultRng
): (state: PlaybackState, action: PlaybackAction) => PlaybackState {
  return (state, action) => playbackReducer(state, action, rng)
}

/**
 * Starts `songId`: marks it played (the invariant), bumps the play token, appends to history.
 * `resetPlayed` drops the current queue's other flags first, so the map ends up as
 * `{ songId: true }`.
 */
function startSong(state: PlaybackState, songId: string, resetPlayed: boolean): PlaybackState {
  // With no queue selected nothing can be marked played, so nothing may become current either.
  if (state.queueId === null) return state

  const kept = resetPlayed ? {} : playedInCurrentQueue(state)
  return {
    ...state,
    currentId: songId,
    isPlaying: true,
    playToken: state.playToken + 1,
    playedByQueue: withCurrentPlayed(state, { ...kept, [songId]: true }),
    // Restarting the song that is already current is not a new entry.
    history: songId === state.currentId ? state.history : pushHistory(state.history, songId)
  }
}

/** Replays the current song: no flag, history or selection changes — just a new play token. */
function restartCurrent(state: PlaybackState): PlaybackState {
  return { ...state, isPlaying: true, playToken: state.playToken + 1 }
}

/** Marks the finished song played, then hands over to `chooseNext`. */
function advance(state: PlaybackState, rng: Rng): PlaybackState {
  const finished = markCurrentPlayed(state)
  const { songId, resetPlayed } = chooseNext(finished, rng)
  if (songId === null) return { ...finished, currentId: null, isPlaying: false }
  return startSong(finished, songId, resetPlayed)
}

/**
 * Steps back to the history entry before the current song, dropping the current one so repeated
 * presses walk further back. Without an earlier entry the current song simply restarts.
 */
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
    playedByQueue: withCurrentPlayed(state, { ...playedInCurrentQueue(state), [previousId]: true })
  }
}

/** Play/pause — or, with nothing cued up yet, start the queue like a manual click. */
function togglePlay(state: PlaybackState): PlaybackState {
  if (state.currentId !== null) return { ...state, isPlaying: !state.isPlaying }
  if (state.order.length === 0) return state
  return startSong(state, state.order[0], true)
}

/** The viewed queue gained or lost songs: keep what is still there, drop what is not. */
function changeOrder(state: PlaybackState, order: readonly string[]): PlaybackState {
  const next = [...order]
  const kept = new Set(next)
  const currentSurvives = state.currentId !== null && kept.has(state.currentId)

  return {
    ...state,
    order: next,
    playedByQueue: withCurrentPlayed(
      state,
      filterPlayed(playedInCurrentQueue(state), (id) => kept.has(id))
    ),
    currentId: currentSurvives ? state.currentId : null,
    isPlaying: currentSurvives && state.isPlaying
  }
}

/** Songs deleted from the library: they must not survive anywhere in playback state. */
function removeSongs(state: PlaybackState, songIds: readonly string[]): PlaybackState {
  const removed = new Set(songIds)
  const survives = (id: string): boolean => !removed.has(id)
  const currentRemoved = state.currentId !== null && removed.has(state.currentId)

  const playedByQueue: Record<string, PlayedMap> = {}
  for (const [queueId, map] of Object.entries(state.playedByQueue)) {
    playedByQueue[queueId] = filterPlayed(map, survives)
  }

  return {
    ...state,
    order: state.order.filter(survives),
    history: state.history.filter(survives),
    playedByQueue,
    currentId: currentRemoved ? null : state.currentId,
    isPlaying: currentRemoved ? false : state.isPlaying
  }
}

/** Marks the current song played. No current song, no change. */
function markCurrentPlayed(state: PlaybackState): PlaybackState {
  if (state.currentId === null) return state
  return {
    ...state,
    playedByQueue: withCurrentPlayed(state, {
      ...playedInCurrentQueue(state),
      [state.currentId]: true
    })
  }
}

/** `playedByQueue` with the current queue's map replaced. Without a queue there is nowhere to put it. */
function withCurrentPlayed(state: PlaybackState, map: PlayedMap): PlayedByQueue {
  if (state.queueId === null) return state.playedByQueue
  return { ...state.playedByQueue, [state.queueId]: map }
}

/** A copy of `map` holding only the ids `keep` accepts. */
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
