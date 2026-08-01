/**
 * Read-only views over `PlaybackState`. Played flags are per-queue, so every read is scoped to the
 * queue that is currently selected.
 */
import type { PlaybackState } from './types'

const NOTHING_PLAYED: Readonly<Record<string, true>> = {}

/**
 * The current queue's played map — empty when no queue is selected or the queue is untouched.
 *
 * Exported because the engine needs the same scoped lookup to build its next map; it is the one
 * piece of state shape both modules share.
 */
export function playedInCurrentQueue(state: PlaybackState): Readonly<Record<string, true>> {
  if (state.queueId === null) return NOTHING_PLAYED
  return state.playedByQueue[state.queueId] ?? NOTHING_PLAYED
}

/** Whether `songId` is marked played in the CURRENT queue. */
export function isPlayed(state: PlaybackState, songId: string): boolean {
  return playedInCurrentQueue(state)[songId] === true
}

/** Position of the current song in the queue order; -1 when there is none. */
export function currentIndex(state: PlaybackState): number {
  if (state.currentId === null) return -1
  return state.order.indexOf(state.currentId)
}

/** How many songs are marked played in the current queue. */
export function playedCount(state: PlaybackState): number {
  return Object.keys(playedInCurrentQueue(state)).length
}
