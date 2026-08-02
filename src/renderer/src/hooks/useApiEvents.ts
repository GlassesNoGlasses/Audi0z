import { useEffect, type Dispatch } from 'react'
import { errorMessage } from '../lib/errors'
import type { AppAction } from '../state/appReducer'

/**
 * Re-reads the library and the playlists. Called after every mutation and whenever the main
 * process announces a change, so the renderer never has to guess how a write reshaped the data.
 */
export async function refreshLibrary(dispatch: Dispatch<AppAction>): Promise<void> {
  try {
    const [songs, playlists] = await Promise.all([
      window.api.library.list(),
      window.api.playlists.list()
    ])
    dispatch({ type: 'library/loaded', songs })
    dispatch({ type: 'playlists/loaded', playlists })
  } catch (error) {
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })
  }
}

/**
 * Subscribes to the two main -> renderer push channels for the lifetime of the app, and hands the
 * preload's unsubscribe functions back on unmount.
 */
export function useApiEvents(dispatch: Dispatch<AppAction>): void {
  useEffect(() => {
    const unsubscribeChanged = window.api.events.onLibraryChanged(() => {
      void refreshLibrary(dispatch)
    })
    const unsubscribeError = window.api.events.onError((error) => {
      dispatch({ type: 'toast/pushed', message: error.message })
    })
    return () => {
      unsubscribeChanged()
      unsubscribeError()
    }
  }, [dispatch])
}
