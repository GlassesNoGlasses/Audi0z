/** Playback contracts. Pure, like the rest of `playback/`: no React, DOM, electron or timers. */

/** Queue id of the Library view. Playlists use their own ids. */
export const LIBRARY_QUEUE_ID = 'library'

export type QueueId = string

/** Returns an integer in `[0, upperExclusive)`. Injected so the engine stays deterministic. */
export type Rng = (upperExclusive: number) => number

export interface PlaybackState {
  queueId: QueueId | null
  order: readonly string[]
  currentId: string | null
  /** Played ids in the CURRENT queue only — cleared on every queue switch. Never persisted. */
  played: Readonly<Record<string, true>>
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
      /** Play this song in the new queue rather than stopping; must be present in `order`. */
      startSongId?: string
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
  /** A playlist died; if it owned the queue, the queue dies with it. */
  | { type: 'playlists/removed'; playlistId: string }

export interface NextSelection {
  songId: string | null
  resetPlayed: boolean
}
