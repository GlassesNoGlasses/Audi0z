import { isPlayed } from './selectors'
import type { NextSelection, PlaybackState, Rng } from './types'

/**
 * The playback rulebook, as pure functions: state in, state out. No React, no DOM, no timers, and
 * no randomness beyond the injected `Rng`.
 */

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
