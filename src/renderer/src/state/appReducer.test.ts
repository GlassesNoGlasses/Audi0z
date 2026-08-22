import { describe, expect, it } from 'vitest'
import { LIBRARY_QUEUE_ID } from '../playback/types'
import { playlist, song } from '../testing/harness'
import {
  createAppReducer,
  initialAppState,
  SortDirection,
  SortType,
  type AppState
} from './appReducer'

/** The app reducer owns everything the playback engine does not, and forwards the rest verbatim. */

const reducer = createAppReducer(() => 0)

function seeded(): AppState {
  const start = initialAppState()
  const songs = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')]
  const withSongs = reducer(start, { type: 'library/loaded', songs })
  return reducer(withSongs, {
    type: 'queue/selected',
    queueId: LIBRARY_QUEUE_ID,
    order: ['a', 'b', 'c'],
    shuffle: false,
    repeat: false
  })
}

describe('appReducer', () => {
  it('starts empty, on the library view, with no queue selected', () => {
    const state = initialAppState()
    expect(state.songs).toEqual([])
    expect(state.view).toEqual({ kind: 'library' })
    expect(state.playback.queueId).toBeNull()
    expect(state.toasts).toEqual([])
  })

  it('forwards playback actions to the playback engine', () => {
    const state = reducer(seeded(), { type: 'song/selected', songId: 'b' })
    expect(state.playback.currentId).toBe('b')
    expect(state.playback.isPlaying).toBe(true)
  })

  it('returns the identical state object when an action changes nothing', () => {
    // Nothing is playing, so stepping back is a no-op the engine answers with the same object.
    const state = seeded()
    expect(reducer(state, { type: 'transport/prev' })).toBe(state)
  })

  it('drops removed songs from the library AND from playback state', () => {
    const playing = reducer(seeded(), { type: 'song/selected', songId: 'b' })
    const state = reducer(playing, { type: 'library/songsRemoved', songIds: ['b'] })

    expect(state.songs.map((s) => s.id)).toEqual(['a', 'c'])
    expect(state.playback.currentId).toBeNull()
    expect(state.playback.order).toEqual(['a', 'c'])
  })

  it('replaces a song in place when it is updated', () => {
    const state = reducer(seeded(), {
      type: 'library/songUpdated',
      song: song('b', 'Bravo (remix)', { tags: ['edit'] })
    })
    expect(state.songs.map((s) => s.title)).toEqual(['Alpha', 'Bravo (remix)', 'Charlie'])
    expect(state.songs[1].tags).toEqual(['edit'])
  })

  it('merges a batch of updated songs without touching the rest', () => {
    const state = seeded()
    const next = reducer(state, {
      type: 'library/songsUpdated',
      songs: [
        song('a', 'Alpha', { durationSec: 173 }),
        // A song the batch names but the library no longer holds changes nothing.
        song('gone', 'Gone', { durationSec: 9 })
      ]
    })

    expect(next.songs.map((s) => [s.id, s.durationSec])).toEqual([
      ['a', 173],
      ['b', undefined],
      ['c', undefined]
    ])
    expect(next.playback).toBe(state.playback)
  })

  it('flags a song as missing without touching the rest', () => {
    const state = reducer(seeded(), { type: 'library/songMissing', songId: 'b' })
    expect(state.songs.map((s) => s.exists)).toEqual([true, false, true])
  })

  /** `SongDto` promises `sizeBytes` is null exactly when `exists` is false — including in here. */
  it('clears the size of a song it flags as missing', () => {
    const state = reducer(seeded(), { type: 'library/songMissing', songId: 'b' })

    expect(state.songs[1].sizeBytes).toBeNull()
    expect(state.songs.map((s) => s.sizeBytes === null)).toEqual([false, true, false])
  })

  it('upserts and removes playlists', () => {
    const created = reducer(seeded(), {
      type: 'playlists/upserted',
      playlist: playlist('p1', 'Mixes', [])
    })
    expect(created.playlists).toHaveLength(1)

    const renamed = reducer(created, {
      type: 'playlists/upserted',
      playlist: playlist('p1', 'Mashups', ['a'])
    })
    expect(renamed.playlists).toEqual([playlist('p1', 'Mashups', ['a'])])

    const removed = reducer(renamed, { type: 'playlists/removed', playlistId: 'p1' })
    expect(removed.playlists).toEqual([])
  })

  /** A deleted playlist cannot stay the queue — the toggles would write shuffle to a dead id. */
  it('drops a deleted playlist from the queue as well as from the list', () => {
    const listed = reducer(seeded(), {
      type: 'playlists/upserted',
      playlist: playlist('p1', 'Mixes', ['a'])
    })
    const expanded = reducer(listed, { type: 'playlist/expandToggled', playlistId: 'p1' })
    const queued = reducer(expanded, {
      type: 'queue/selected',
      queueId: 'p1',
      order: ['a'],
      shuffle: false,
      repeat: false,
      startSongId: 'a'
    })
    expect(queued.playback.currentId).toBe('a')

    const next = reducer(queued, { type: 'playlists/removed', playlistId: 'p1' })

    expect(next.playlists).toEqual([])
    expect(next.playback.queueId).toBeNull()
    expect(next.playback.currentId).toBeNull()
    expect(next.playback.order).toEqual([])
    expect([...next.expandedPlaylists]).toEqual([])
    expect(next.songs.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('toggles a playlist open and shut without touching the queue', () => {
    const before = seeded()
    const opened = reducer(before, { type: 'playlist/expandToggled', playlistId: 'p1' })
    expect([...opened.expandedPlaylists]).toEqual(['p1'])
    expect(opened.playback).toBe(before.playback)

    const closed = reducer(opened, { type: 'playlist/expandToggled', playlistId: 'p1' })
    expect([...closed.expandedPlaylists]).toEqual([])
  })

  it('opens and closes dialogs', () => {
    const opened = reducer(seeded(), { type: 'dialog/opened', dialog: { kind: 'settings' } })
    expect(opened.dialog).toEqual({ kind: 'settings' })
    expect(reducer(opened, { type: 'dialog/closed' }).dialog).toBeNull()
  })

  it('opens the tag and add-to-playlist dialogs', () => {
    const tags = reducer(seeded(), { type: 'dialog/opened', dialog: { kind: 'tags' } })
    expect(tags.dialog).toEqual({ kind: 'tags' })

    const adding = reducer(tags, {
      type: 'dialog/opened',
      dialog: { kind: 'addToPlaylist', playlistId: 'p1' }
    })
    expect(adding.dialog).toEqual({ kind: 'addToPlaylist', playlistId: 'p1' })
  })

  it('starts with no tags and takes the registry as it is loaded', () => {
    expect(initialAppState().tags).toEqual([])

    const loaded = reducer(seeded(), {
      type: 'tags/loaded',
      tags: [{ id: 't1', name: 'slowed', color: '#5ca8e0' }]
    })
    expect(loaded.tags).toEqual([{ id: 't1', name: 'slowed', color: '#5ca8e0' }])

    const emptied = reducer(loaded, { type: 'tags/loaded', tags: [] })
    expect(emptied.tags).toEqual([])
  })

  it('stacks toasts and dismisses them by id', () => {
    const one = reducer(seeded(), { type: 'toast/pushed', message: 'disk on fire' })
    const two = reducer(one, { type: 'toast/pushed', message: 'network on fire' })

    expect(two.toasts.map((t) => t.message)).toEqual(['disk on fire', 'network on fire'])

    const dismissed = reducer(two, { type: 'toast/dismissed', id: two.toasts[0].id })
    expect(dismissed.toasts.map((t) => t.message)).toEqual(['network on fire'])
  })

  it('keeps a report that says something the ones on screen do not', () => {
    // Main forwards a bare message; the renderer's own catch adds context — both are shown.
    const fromMain = reducer(seeded(), {
      type: 'toast/pushed',
      message: 'Failed to move item to trash'
    })
    const withContext = reducer(fromMain, {
      type: 'toast/pushed',
      message: 'Failed to move item to trash — the song is still in your library.'
    })

    expect(withContext.toasts.map((t) => t.message)).toEqual([
      'Failed to move item to trash',
      'Failed to move item to trash — the song is still in your library.'
    ])
    expect(new Set(withContext.toasts.map((t) => t.id)).size).toBe(2)
  })

  it('collapses a report identical to one already on screen', () => {
    // Both paths normalise through `errorMessage`, so one failure can arrive twice, identically.
    const once = reducer(seeded(), { type: 'toast/pushed', message: 'ffmpeg exited with code 1' })
    const twice = reducer(once, { type: 'toast/pushed', message: 'ffmpeg exited with code 1' })

    expect(twice).toBe(once)
    expect(twice.toasts.map((t) => t.message)).toEqual(['ffmpeg exited with code 1'])
  })

  it('shows the same message again once the first one has been dismissed', () => {
    // The collapse is against what is on screen, not a history.
    const once = reducer(seeded(), { type: 'toast/pushed', message: 'disk on fire' })
    const dismissed = reducer(once, { type: 'toast/dismissed', id: once.toasts[0].id })
    const again = reducer(dismissed, { type: 'toast/pushed', message: 'disk on fire' })

    expect(again.toasts.map((t) => t.message)).toEqual(['disk on fire'])
    expect(again.toasts[0].id).not.toBe(once.toasts[0].id)
  })

  it('records the search query and the selected view', () => {
    const searched = reducer(seeded(), { type: 'query/changed', query: 'slowed' })
    expect(searched.query).toBe('slowed')

    const viewed = reducer(searched, {
      type: 'view/selected',
      view: { kind: 'playlist', id: 'p1' }
    })
    expect(viewed.view).toEqual({ kind: 'playlist', id: 'p1' })
  })

  /** The sort is global, like the query: it belongs to the window, not to the view. */
  it('records the sort mode and keeps it across a change of view', () => {
    // The stored order is where every window starts — nothing persists the sort across launches.
    expect(initialAppState().sort).toEqual({
      type: SortType.CUSTOM,
      direction: SortDirection.ASC
    })

    const sorted = reducer(seeded(), {
      type: 'sort/changed',
      sort: { type: SortType.DURATION, direction: SortDirection.DESC }
    })
    expect(sorted.sort).toEqual({ type: SortType.DURATION, direction: SortDirection.DESC })

    const viewed = reducer(sorted, { type: 'view/selected', view: { kind: 'playlist', id: 'p1' } })
    expect(viewed.sort).toEqual({ type: SortType.DURATION, direction: SortDirection.DESC })

    const custom = reducer(viewed, {
      type: 'sort/changed',
      sort: { type: SortType.CUSTOM, direction: SortDirection.ASC }
    })
    expect(custom.sort).toEqual({ type: SortType.CUSTOM, direction: SortDirection.ASC })
  })
})

describe('library/reordered', () => {
  it('maps the songs it already holds into the given order', () => {
    const state = seeded()

    const next = reducer(state, { type: 'library/reordered', order: ['c', 'a', 'b'] })

    expect(next.songs.map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    // The same objects, in a new order — nothing is refetched or rebuilt.
    expect(next.songs[0]).toBe(state.songs[2])
  })

  it('ignores unknown ids and keeps unnamed songs at the end', () => {
    const state = seeded()

    const next = reducer(state, { type: 'library/reordered', order: ['b', 'ghost'] })

    expect(next.songs.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
  })
})
