/**
 * Read-only views over `PlaybackState`. Played flags belong to the current queue — the engine
 * clears the set on every queue switch, so every read is already scoped.
 */
import type { PlaybackState } from './types'

/** Whether `songId` is marked played in the current queue. */
export function isPlayed(state: PlaybackState, songId: string): boolean {
  return state.played[songId] === true
}

/** Position of the current song in the queue order; -1 when there is none. */
export function currentIndex(state: PlaybackState): number {
  if (state.currentId === null) return -1
  return state.order.indexOf(state.currentId)
}

/** How many songs are marked played in the current queue. */
export function playedCount(state: PlaybackState): number {
  return Object.keys(state.played).length
}
