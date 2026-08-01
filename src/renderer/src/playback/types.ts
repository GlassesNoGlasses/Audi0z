/**
 * Playback contracts.
 *
 * This module — like the rest of `playback/` — is pure: it imports nothing outside
 * `src/shared/types` and its siblings, and knows nothing about React, the DOM, electron, timers or
 * randomness (the rng is injected).
 */

/** Queue id of the Library view. Playlists use their own ids. */
export const LIBRARY_QUEUE_ID = 'library'

export type QueueId = string

/** Returns an integer in `[0, upperExclusive)`. Injected so the engine stays deterministic. */
export type Rng = (upperExclusive: number) => number

export interface PlaybackState {
  queueId: QueueId | null
  /** Current queue's song ids, in queue order. */
  order: readonly string[]
  currentId: string | null
  playedByQueue: Readonly<Record<QueueId, Readonly<Record<string, true>>>>
  /** Actually-played ids, oldest→newest, capped at 100, cleared on queue switch. */
  history: readonly string[]
  shuffle: boolean
  repeat: boolean
  isPlaying: boolean
  /** Increments on every (re)start of the current song. */
  playToken: number
}

export type PlaybackAction =
  | {
      type: 'queue/selected'
      queueId: QueueId
      order: readonly string[]
      shuffle: boolean
      repeat: boolean
    }
  | { type: 'queue/orderChanged'; order: readonly string[] }
  | { type: 'song/selected'; songId: string }
  | { type: 'song/ended' }
  | { type: 'transport/next' }
  | { type: 'transport/prev' }
  | { type: 'transport/play' }
  | { type: 'transport/pause' }
  | { type: 'transport/togglePlay' }
  | { type: 'transport/setShuffle'; value: boolean }
  | { type: 'transport/setRepeat'; value: boolean }
  | { type: 'library/songsRemoved'; songIds: readonly string[] }

export interface NextSelection {
  songId: string | null
  resetPlayed: boolean
}
