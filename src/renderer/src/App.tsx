import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { AddSongDialog } from './components/AddSongDialog'
import { AddToPlaylistDialog } from './components/AddToPlaylistDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { EditSongDialog } from './components/EditSongDialog'
import { PlayerBar } from './components/PlayerBar'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SongList } from './components/SongList'
import { TagsDialog } from './components/TagsDialog'
import { ToastHost } from './components/ToastHost'
import { TopNav } from './components/TopNav'
import { useApiEvents, refreshLibrary } from './hooks/useApiEvents'
import { useAudioElement } from './hooks/useAudioElement'
import { useClickFocusReset } from './hooks/useClickFocusReset'
import { useDurationBackfill } from './hooks/useDurationBackfill'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaSession } from './hooks/useMediaSession'
import { useSmartPrev } from './hooks/useSmartPrev'
import { toastError, trashFailureMessage } from './lib/errors'
import { songsInView, sortSongs } from './lib/viewSongs'
import { currentSong } from './playback/selectors'
import { LIBRARY_QUEUE_ID } from './playback/types'
import { AppProvider, useAppDispatch, useAppState } from './state/AppContext'
import { SortDirection, SortType, type ConfirmIntent, type SortMode } from './state/appReducer'

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** The same songs, in any order — a reorder, not a song joining or leaving. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const members = new Set(b)
  return a.every((id) => members.has(id))
}

/** By value, not identity — a fresh object with the same keys is the same sort. */
function sameSort(a: SortMode, b: SortMode): boolean {
  return a.type === b.type && a.direction === b.direction
}

export function App(): ReactElement {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  )
}

/** Layout, start-up, and the effects that keep the store in step with the outside world. */
function AppShell(): ReactElement {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { songs, playlists, settings, sort, playback, dialog } = state

  useApiEvents(dispatch)
  useDurationBackfill(songs, dispatch, !playback.isPlaying)

  // Start-up: load everything, then make the Library the queue.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loadedSettings, loadedSongs, loadedPlaylists, loadedTags] = await Promise.all([
          window.api.settings.get(),
          window.api.library.list(),
          window.api.playlists.list(),
          window.api.tags.list()
        ])
        if (cancelled) return
        dispatch({ type: 'settings/updated', settings: loadedSettings })
        dispatch({ type: 'library/loaded', songs: loadedSongs })
        dispatch({ type: 'playlists/loaded', playlists: loadedPlaylists })
        dispatch({ type: 'tags/loaded', tags: loadedTags })
        dispatch({
          type: 'queue/selected',
          queueId: LIBRARY_QUEUE_ID,
          order: loadedSongs.map((song) => song.id),
          shuffle: loadedSettings.libraryShuffle,
          repeat: loadedSettings.libraryRepeat
        })
      } catch (error) {
        if (!cancelled) toastError(dispatch, error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dispatch])

  const queueOrder = useMemo(() => {
    const queueId = playback.queueId
    if (queueId === null) return null
    const source =
      queueId === LIBRARY_QUEUE_ID
        ? songs
        : // Unsorted here on purpose: `sortSongs` below orders the queue once, whichever it is.
          songsInView(
            songs,
            playlists.find((playlist) => playlist.id === queueId) ?? null,
            { kind: 'playlist', id: queueId },
            { type: SortType.CUSTOM, direction: SortDirection.ASC }
          )
    return sortSongs(source, sort).map((song) => song.id)
  }, [playback.queueId, songs, playlists, sort])

  /** The sort the queue was last built with; a differing value means the user just asked. */
  const lastAppliedSort = useRef(sort)

  // INVARIANT: under a MUTABLE sort key (`title`, `durationSec`) a data change must not reorder a
  // queue that is playing — it defers; sort gestures and membership changes apply at once.
  useEffect(() => {
    if (queueOrder === null) return
    if (sameOrder(queueOrder, playback.order)) {
      lastAppliedSort.current = sort
      return
    }
    const membershipChanged = !sameMembers(queueOrder, playback.order)
    if (playback.isPlaying && !membershipChanged && sameSort(lastAppliedSort.current, sort)) return
    lastAppliedSort.current = sort
    dispatch({ type: 'queue/orderChanged', order: queueOrder })
  }, [queueOrder, playback.order, playback.isPlaying, sort, dispatch])

  const current = currentSong(songs, playback)

  const handleEnded = useCallback(() => dispatch({ type: 'song/ended' }), [dispatch])
  const handleError = useCallback(
    (songId: string) => {
      const failed = songs.find((song) => song.id === songId)
      dispatch({
        type: 'toast/pushed',
        message: `Could not play "${failed?.title ?? songId}" — its file is missing.`
      })
      dispatch({ type: 'library/songMissing', songId })
      const playableRemains = playback.order.some(
        (id) => id !== songId && songs.find((song) => song.id === id)?.exists !== false
      )
      dispatch(playableRemains ? { type: 'transport/next' } : { type: 'transport/pause' })
    },
    [dispatch, songs, playback.order]
  )

  const {
    ref: audioRef,
    seekBy,
    beginScrub,
    endScrub
  } = useAudioElement({
    songId: current?.id ?? null,
    src: current?.url ?? null,
    playToken: playback.playToken,
    isPlaying: playback.isPlaying,
    volume: settings.volume,
    onEnded: handleEnded,
    onError: handleError
  })

  const smartPrev = useSmartPrev(audioRef)
  const mediaPlay = useCallback(() => dispatch({ type: 'transport/play' }), [dispatch])
  const mediaPause = useCallback(() => dispatch({ type: 'transport/pause' }), [dispatch])
  const mediaNext = useCallback(() => dispatch({ type: 'transport/next' }), [dispatch])

  // AirPods taps, keyboard media keys, the macOS Now Playing widget
  useMediaSession({
    title: current?.title ?? null,
    isPlaying: playback.isPlaying,
    onPlay: mediaPlay,
    onPause: mediaPause,
    onNext: mediaNext,
    onPrev: smartPrev
  })

  /** What to come back to when unmuting — muting must not lose where the slider was. */
  const lastAudibleVolume = useRef(1)

  useEffect(() => {
    if (settings.volume > 0) lastAudibleVolume.current = settings.volume
  }, [settings.volume])

  const togglePlay = useCallback(() => dispatch({ type: 'transport/togglePlay' }), [dispatch])

  const toggleMute = useCallback(() => {
    const next = settings.volume === 0 ? lastAudibleVolume.current || 1 : 0
    dispatch({ type: 'settings/updated', settings: { ...settings, volume: next } })
    void window.api.settings
      .set({ volume: next })
      .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
      .catch((error: unknown) => toastError(dispatch, error))
  }, [dispatch, settings])

  // Every click hands the keyboard back, so the shortcuts below reach the transport rather than a
  // focused button or slider.
  useClickFocusReset()

  useKeyboardShortcuts({
    enabled: dialog === null,
    hasCurrentSong: playback.currentId !== null,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute,
    onSeekBy: seekBy
  })

  function confirmIntent(intent: ConfirmIntent): void {
    dispatch({ type: 'dialog/closed' })
    if (intent.kind === 'deleteSong') {
      void window.api.library
        .remove(intent.songId)
        .then(async () => {
          dispatch({ type: 'library/songsRemoved', songIds: [intent.songId] })
          await refreshLibrary(dispatch)
        })
        .catch((error: unknown) => {
          dispatch({ type: 'toast/pushed', message: trashFailureMessage(error) })
        })
      return
    }
    void window.api.playlists
      .remove(intent.playlistId)
      .then(() => {
        dispatch({ type: 'playlists/removed', playlistId: intent.playlistId })
        if (state.view.kind === 'playlist' && state.view.id === intent.playlistId) {
          dispatch({ type: 'view/selected', view: { kind: 'library' } })
        }
      })
      .catch((error: unknown) => toastError(dispatch, error))
  }

  /** No `default` arm on purpose: a new `Dialog` kind fails to compile instead of rendering nothing. */
  const dialogSwitch = (): ReactElement => {
    if (dialog === null) return <></>

    switch (dialog.kind) {
      case 'add':
        return <AddSongDialog source={dialog.source} />
      case 'edit':
        return <EditSongDialog songId={dialog.songId} />
      case 'settings':
        return <SettingsDialog />
      case 'tags':
        return <TagsDialog />
      case 'addToPlaylist':
        return <AddToPlaylistDialog playlistId={dialog.playlistId} />
      case 'confirm':
        return (
          <ConfirmDialog
            message={dialog.message}
            confirmLabel={dialog.confirmLabel}
            onConfirm={() => confirmIntent(dialog.intent)}
            onCancel={() => dispatch({ type: 'dialog/closed' })}
          />
        )
    }
  }

  return (
    <div className="app">
      <Sidebar />
      <section className="library">
        <TopNav />
        <SongList />
      </section>
      <PlayerBar audioRef={audioRef} beginScrub={beginScrub} endScrub={endScrub} />
      <ToastHost />
      {dialogSwitch()}
      <audio ref={audioRef} className="app-audio" />
    </div>
  )
}
