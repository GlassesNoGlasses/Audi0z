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
    // Through `errorMessage` like every other call site: one failure reported on both paths has to
    // arrive as the same string, or the reducer's duplicate collapse cannot see that it is one.
    // (Nothing was serialised on this path, so only the trim and the empty-message fallback
    // normally bite. A main-side message that opened with a `ClassName: ` of its own would lose
    // it — none of the ones this app produces do; yt-dlp's `ERROR:` lines arrive below a summary
    // line, not at the front.)
    const unsubscribeError = window.api.events.onError((error) => {
      dispatch({ type: 'toast/pushed', message: errorMessage(error.message) })
    })
    return () => {
      unsubscribeChanged()
      unsubscribeError()
    }
  }, [dispatch])
}
