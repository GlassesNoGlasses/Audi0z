import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useToastError } from '../hooks/useToastError'
import { filterSongs } from '../lib/search'
import { mergeReorderedIds, songsInView, viewedPlaylist } from '../lib/viewSongs'
import { LIBRARY_QUEUE_ID } from '../playback/types'
import { useAppDispatch, useAppState } from '../state/AppContext'
import { SortType, type AppState } from '../state/appReducer'
import { SongRow } from './SongRow'

/** Where a drag in flight would land: the row under the pointer, and which side of its midpoint. */
type DropMark = { id: string; edge: 'before' | 'after' }

export function SongList(): ReactElement {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { songs, playlists, tags, settings, query, sort, view, playback } = state

  const containingPlaylist = useMemo(() => viewedPlaylist(view, playlists), [view, playlists])
  const inView = useMemo(
    () => songsInView(songs, containingPlaylist, view, sort),
    [songs, containingPlaylist, view, sort]
  )
  // The search filters what is SHOWN, never the queue: clicking a filtered row still plays inside
  // the full queue order.
  const visible = useMemo(() => filterSongs(inView, query), [inView, query])

  const fail = useToastError()

  // Dragging rearranges the stored order, so it is only offered when the rows on screen ARE that
  // order: any other sort draws a computed order a drop position says nothing about, and a
  // filtered list says nothing about where the hidden songs go — the sidebar's own rule. A
  // reorder still in flight blocks the next drag too: its arithmetic would use the stale order,
  // and the second write would silently undo the first.
  const [reorderPending, setReorderPending] = useState(false)
  const pendingRef = useRef(false)
  const canDrag = !reorderPending && sort.type === SortType.CUSTOM && query.trim() === ''

  // State draws the seam; the refs are what the drop reads. Split on purpose: the rows are
  // memoised, and callbacks remade on every pointer move would re-render all of them per row
  // crossed, so the callbacks below depend on nothing the drag itself changes.
  const [dragActive, setDragActive] = useState(false)
  const [dropMark, setDropMark] = useState<DropMark | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const dropMarkRef = useRef<DropMark | null>(null)

  const onRowDragStart = useCallback((songId: string) => {
    dragIdRef.current = songId
    setDragActive(true)
  }, [])

  const onRowDragOver = useCallback((songId: string, edge: 'before' | 'after') => {
    dropMarkRef.current = { id: songId, edge }
    setDropMark((current) =>
      current?.id === songId && current.edge === edge ? current : { id: songId, edge }
    )
  }, [])

  const endDrag = useCallback(() => {
    dragIdRef.current = null
    dropMarkRef.current = null
    setDragActive(false)
    setDropMark(null)
  }, [])

  // A source row that unmounts mid-drag (a refresh, a delete, the search filtering it away) can
  // never deliver its dragEnd — without this the list stays armed forever and captures every
  // foreign drag that follows.
  useEffect(() => {
    if (!dragActive) return
    const dragId = dragIdRef.current
    if (dragId !== null && !visible.some((song) => song.id === dragId)) endDrag()
  }, [dragActive, visible, endDrag])

  // Belt to the effect's braces: a release anywhere outside the rows still ends the drag.
  useEffect(() => {
    if (!dragActive) return
    const clear = (): void => endDrag()
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dragActive, endDrag])

  /**
   * Lands the drag: the dragged id is pulled out of the FULL view order and put back beside the
   * target, and the list is redrawn only once the store accepts that order. The write goes to
   * whichever order the view is showing: the playlist's own songIds, or the library's stored
   * order. An authored reorder is a gesture, so when the reordered view IS the playing queue it
   * reaches the engine at once, behind the current song — unlike a data-driven re-sort, which
   * App's fence holds back while music plays.
   */
  const onRowDrop = useCallback(() => {
    const dragId = dragIdRef.current
    const mark = dropMarkRef.current
    endDrag()
    if (pendingRef.current || dragId === null || mark === null || dragId === mark.id) return
    const ids = inView.map((song) => song.id).filter((id) => id !== dragId)
    const at = ids.indexOf(mark.id)
    if (at === -1) return
    ids.splice(mark.edge === 'before' ? at : at + 1, 0, dragId)

    pendingRef.current = true
    setReorderPending(true)
    const settle = (): void => {
      pendingRef.current = false
      setReorderPending(false)
    }

    if (view.kind === 'playlist') {
      // The payload is the playlist's FULL stored order: an id the library cannot resolve is not
      // on screen, but it keeps its place rather than wedging the reorder.
      const known = new Set(inView.map((song) => song.id))
      const stored = containingPlaylist?.songIds ?? []
      void window.api.playlists
        .reorderSongs(view.id, mergeReorderedIds(stored, ids, known))
        .then((playlist) => {
          dispatch({ type: 'playlists/upserted', playlist })
          if (playback.queueId === view.id) dispatch({ type: 'queue/orderChanged', order: ids })
        })
        .catch(fail)
        .finally(settle)
      return
    }
    void window.api.library
      .reorder(ids)
      .then(() => {
        dispatch({ type: 'library/reordered', order: ids })
        if (playback.queueId === LIBRARY_QUEUE_ID) {
          dispatch({ type: 'queue/orderChanged', order: ids })
        }
      })
      .catch(fail)
      .finally(settle)
  }, [endDrag, inView, view, containingPlaylist, playback.queueId, dispatch, fail])

  /**
   * Playing a row is the one gesture that moves the queue. Inside the queue already playing it is
   * a plain song change; anywhere else it hands the queue over to the view first — with the
   * view's FULL order, since the search filters what is shown and never what is queued.
   */
  const onPlay = useCallback(
    (songId: string) => {
      const viewQueueId = view.kind === 'library' ? LIBRARY_QUEUE_ID : view.id
      if (viewQueueId === playback.queueId) {
        dispatch({ type: 'song/selected', songId })
        return
      }
      dispatch({
        type: 'queue/selected',
        queueId: viewQueueId,
        order: inView.map((song) => song.id),
        shuffle: containingPlaylist ? containingPlaylist.shuffle : settings.libraryShuffle,
        repeat: containingPlaylist ? containingPlaylist.repeat : settings.libraryRepeat,
        startSongId: songId
      })
    },
    // The two fields, not the whole `settings`: dragging the volume slider must not invalidate
    // this callback and re-render every memoised row with it.
    [
      dispatch,
      view,
      playback.queueId,
      inView,
      containingPlaylist,
      settings.libraryShuffle,
      settings.libraryRepeat
    ]
  )

  const onEdit = useCallback(
    (songId: string) => dispatch({ type: 'dialog/opened', dialog: { kind: 'edit', songId } }),
    [dispatch]
  )

  const onDelete = useCallback(
    (songId: string) => {
      const song = songs.find((entry) => entry.id === songId)
      dispatch({
        type: 'dialog/opened',
        dialog: {
          kind: 'confirm',
          message: `Move ${song?.title ?? songId} to the trash?`,
          confirmLabel: 'Delete',
          intent: { kind: 'deleteSong', songId }
        }
      })
    },
    [dispatch, songs]
  )

  /**
   * Tag membership is a whole-list write: `library.update` replaces `tags`, so the next list is
   * computed here from what the song carries rather than sent as a delta.
   */
  const onToggleTag = useCallback(
    (songId: string, tagName: string) => {
      const song = songs.find((entry) => entry.id === songId)
      if (!song) return
      const has = song.tags.includes(tagName)
      const nextTags = has ? song.tags.filter((name) => name !== tagName) : [...song.tags, tagName]
      void window.api.library
        .update(songId, { tags: nextTags })
        .then((updated) => dispatch({ type: 'library/songUpdated', song: updated }))
        .catch(fail)
    },
    [dispatch, fail, songs]
  )

  const onRemoveFromPlaylist = useCallback(
    (playlistId: string, songId: string) => {
      void window.api.playlists
        .removeSong(playlistId, songId)
        .then((playlist) => dispatch({ type: 'playlists/upserted', playlist }))
        .catch(fail)
    },
    [dispatch, fail]
  )

  if (visible.length === 0) {
    return <p className="empty-state">{emptyMessage(state)}</p>
  }

  return (
    // The list's own handlers cover the 4px gaps between rows — without them the cursor flips to
    // no-drop crossing each gap and a release there is lost. All three are ours-only (`dragActive`
    // gates), so a foreign drag passes untouched; the rows stopPropagation, so a drop on a row
    // never double-fires here.
    <ul
      className="song-list"
      aria-label="Songs"
      onDragOver={(event) => {
        if (!dragActive) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        onRowDrop()
      }}
      onDragLeave={(event) => {
        if (!dragActive) return
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        dropMarkRef.current = null
        setDropMark(null)
      }}
    >
      {visible.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          isCurrent={song.id === playback.currentId}
          tags={tags}
          containingPlaylist={containingPlaylist}
          draggable={canDrag}
          dragActive={dragActive}
          dropEdge={dropMark?.id === song.id ? dropMark.edge : null}
          onPlay={onPlay}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleTag={onToggleTag}
          onRemoveFromPlaylist={onRemoveFromPlaylist}
          onDragStart={onRowDragStart}
          onDragOver={onRowDragOver}
          onDrop={onRowDrop}
          onDragEnd={endDrag}
        />
      ))}
    </ul>
  )
}

function emptyMessage(state: AppState): string {
  if (state.query.trim() !== '') return 'No songs match your search.'
  if (state.view.kind === 'playlist') return 'This playlist is empty.'
  return 'No songs yet. Add one to get started.'
}
