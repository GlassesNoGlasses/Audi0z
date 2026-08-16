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
import { errorMessage, trashFailureMessage } from './lib/errors'
import { songsInView, sortSongs } from './lib/viewSongs'
import { LIBRARY_QUEUE_ID } from './playback/types'
import { AppProvider, useAppDispatch, useAppState } from './state/AppContext'
import type { ConfirmIntent } from './state/appReducer'

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function App(): ReactElement {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  )
}

/**
 * Layout, start-up, and the handful of effects that keep the store in step with the outside world.
 * Everything with a decision in it lives in a component, a hook or the reducer.
 */
function AppShell(): ReactElement {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { songs, playlists, settings, sort, playback, dialog } = state

  useApiEvents(dispatch)
  // Songs are listed long before anything has decoded their headers; this measures them behind the
  // list and persists what it finds, so the times only ever have to be read once. It only reads
  // while nothing is playing — the probes go through the same `media://` handler the player does.
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
        if (!cancelled) dispatch({ type: 'toast/pushed', message: errorMessage(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dispatch])

  // The queue follows its source: adding to the library, or to the playlist being played, extends
  // the queue in place rather than restarting it — and it follows the sort the same way, so what
  // plays next is what the list shows.
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
            null
          )
    return sortSongs(source, sort).map((song) => song.id)
  }, [playback.queueId, songs, playlists, sort])

  useEffect(() => {
    if (queueOrder === null || sameOrder(queueOrder, playback.order)) return
    dispatch({ type: 'queue/orderChanged', order: queueOrder })
  }, [queueOrder, playback.order, dispatch])

  const current = songs.find((song) => song.id === playback.currentId) ?? null

  const handleEnded = useCallback(() => dispatch({ type: 'song/ended' }), [dispatch])

  /**
   * The file behind the current song will not play. Say so, remember that it is gone, and move on
   * — but only while something else in the queue still can, otherwise a queue of broken files
   * would error its way round in a loop. (`song/ended` is deliberately not used here: it honours
   * repeat, which would restart the unplayable song forever.)
   */
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

  // AirPods taps, keyboard media keys, the macOS Now Playing widget — same four commands.
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

  // Applied to the store first so the audio and the slider react on the keystroke, then persisted
  // — the same order the volume slider itself uses.
  const toggleMute = useCallback(() => {
    const next = settings.volume === 0 ? lastAudibleVolume.current || 1 : 0
    dispatch({ type: 'settings/updated', settings: { ...settings, volume: next } })
    void window.api.settings
      .set({ volume: next })
      .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
      .catch((error: unknown) => dispatch({ type: 'toast/pushed', message: errorMessage(error) }))
  }, [dispatch, settings])

  // Every mouse click hands the keyboard back: without this the shortcuts below reach a focused
  // button or slider instead of the transport, and the click leaves a focus ring behind.
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
      .catch((error: unknown) => dispatch({ type: 'toast/pushed', message: errorMessage(error) }))
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

      {dialog?.kind === 'add' ? <AddSongDialog source={dialog.source} /> : null}
      {dialog?.kind === 'edit' ? <EditSongDialog songId={dialog.songId} /> : null}
      {dialog?.kind === 'settings' ? <SettingsDialog /> : null}
      {dialog?.kind === 'tags' ? <TagsDialog /> : null}
      {dialog?.kind === 'addToPlaylist' ? (
        <AddToPlaylistDialog playlistId={dialog.playlistId} />
      ) : null}
      {dialog?.kind === 'confirm' ? (
        <ConfirmDialog
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          onConfirm={() => confirmIntent(dialog.intent)}
          onCancel={() => dispatch({ type: 'dialog/closed' })}
        />
      ) : null}

      <audio ref={audioRef} className="app-audio" />
    </div>
  )
}
