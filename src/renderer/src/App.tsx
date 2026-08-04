import { useCallback, useEffect, useMemo, useRef, type DragEvent, type ReactElement } from 'react'
import { AddSongDialog } from './components/AddSongDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { EditSongDialog } from './components/EditSongDialog'
import { PlayerBar } from './components/PlayerBar'
import { SearchBox } from './components/SearchBox'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SongList } from './components/SongList'
import { ToastHost } from './components/ToastHost'
import { useApiEvents, refreshLibrary } from './hooks/useApiEvents'
import { useAudioElement } from './hooks/useAudioElement'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { errorMessage, isTrashFailure } from './lib/errors'
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
  const { songs, playlists, settings, playback, dialog } = state

  useApiEvents(dispatch)

  // Start-up: load everything, then make the Library the queue.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loadedSettings, loadedSongs, loadedPlaylists] = await Promise.all([
          window.api.settings.get(),
          window.api.library.list(),
          window.api.playlists.list()
        ])
        if (cancelled) return
        dispatch({ type: 'settings/updated', settings: loadedSettings })
        dispatch({ type: 'library/loaded', songs: loadedSongs })
        dispatch({ type: 'playlists/loaded', playlists: loadedPlaylists })
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
  // the queue in place rather than restarting it.
  const queueOrder = useMemo(() => {
    const queueId = playback.queueId
    if (queueId === null) return null
    if (queueId === LIBRARY_QUEUE_ID) return songs.map((song) => song.id)
    return playlists.find((playlist) => playlist.id === queueId)?.songIds ?? []
  }, [playback.queueId, songs, playlists])

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

  const audioRef = useAudioElement({
    songId: current?.id ?? null,
    src: current?.url ?? null,
    playToken: playback.playToken,
    isPlaying: playback.isPlaying,
    volume: settings.volume,
    onEnded: handleEnded,
    onError: handleError
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

  useKeyboardShortcuts({
    enabled: dialog === null,
    hasCurrentSong: playback.currentId !== null,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute
  })

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    // Electron 43 removed `File.path`; the preload's `webUtils` helper is the only way to a path.
    const paths = Array.from(files).map((file) => window.api.files.getPathForFile(file))
    dispatch({ type: 'dialog/opened', dialog: { kind: 'add', source: { kind: 'files', paths } } })
  }

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
          dispatch({
            type: 'toast/pushed',
            message: isTrashFailure(error)
              ? `${errorMessage(error)} — the song is still in your library.`
              : errorMessage(error)
          })
        })
      return
    }
    void window.api.playlists
      .remove(intent.playlistId)
      .then(() => {
        dispatch({ type: 'playlists/removed', playlistId: intent.playlistId })
        // The view has nowhere left to be. The QUEUE is not touched: it may well be the library's,
        // playing happily, and if it was this playlist's then the order effect above empties it.
        if (state.view.kind === 'playlist' && state.view.id === intent.playlistId) {
          dispatch({ type: 'view/selected', view: { kind: 'library' } })
        }
      })
      .catch((error: unknown) => dispatch({ type: 'toast/pushed', message: errorMessage(error) }))
  }

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <Sidebar />
      <section className="library">
        <header className="toolbar">
          <SearchBox />
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: 'dialog/opened',
                dialog: { kind: 'add', source: { kind: 'files', paths: [] } }
              })
            }
          >
            Add song
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'dialog/opened', dialog: { kind: 'settings' } })}
          >
            Settings
          </button>
        </header>
        <SongList />
      </section>
      <PlayerBar audioRef={audioRef} />
      <ToastHost />

      {dialog?.kind === 'add' ? <AddSongDialog source={dialog.source} /> : null}
      {dialog?.kind === 'edit' ? <EditSongDialog songId={dialog.songId} /> : null}
      {dialog?.kind === 'settings' ? <SettingsDialog /> : null}
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
