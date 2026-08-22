import { useEffect, type Dispatch } from 'react'
import { toastError } from '../lib/errors'
import type { AppAction } from '../state/appReducer'

/**
 * Re-reads library, playlists and the tag registry after every mutation and on every announced
 * change. Read together because a tag rename or delete cascades through the songs.
 */
export async function refreshLibrary(dispatch: Dispatch<AppAction>): Promise<void> {
  try {
    const [songs, playlists, tags] = await Promise.all([
      window.api.library.list(),
      window.api.playlists.list(),
      window.api.tags.list()
    ])
    dispatch({ type: 'library/loaded', songs })
    dispatch({ type: 'playlists/loaded', playlists })
    dispatch({ type: 'tags/loaded', tags })
  } catch (error) {
    toastError(dispatch, error)
  }
}

/** Just the registry — what a tag created in the Tags dialog changed, and nothing else. */
export async function refreshTags(dispatch: Dispatch<AppAction>): Promise<void> {
  try {
    dispatch({ type: 'tags/loaded', tags: await window.api.tags.list() })
  } catch (error) {
    toastError(dispatch, error)
  }
}

/** Subscribes to the two main -> renderer push channels for the lifetime of the app. */
export function useApiEvents(dispatch: Dispatch<AppAction>): void {
  useEffect(() => {
    const unsubscribeChanged = window.api.events.onLibraryChanged(() => {
      void refreshLibrary(dispatch)
    })
    // Through `toastError` like every other call site: one failure reported on both paths must
    // arrive as the same string, or the reducer's duplicate collapse cannot see it is one.
    const unsubscribeError = window.api.events.onError((error) => {
      toastError(dispatch, error.message)
    })
    return () => {
      unsubscribeChanged()
      unsubscribeError()
    }
  }, [dispatch])
}
