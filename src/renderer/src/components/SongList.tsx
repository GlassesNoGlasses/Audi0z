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
  // The search filters what is SHOWN, never the queue.
  const visible = useMemo(() => filterSongs(inView, query), [inView, query])

  const fail = useToastError()

  // Drag only when the rows on screen ARE the stored order. A reorder still in flight blocks the
  // next: its arithmetic would use the stale order and the second write would undo the first.
  const [reorderPending, setReorderPending] = useState(false)
  const pendingRef = useRef(false)
  const canDrag = !reorderPending && sort.type === SortType.CUSTOM && query.trim() === ''

  // State draws the seam, the refs are what the drop reads: the callbacks below depend on nothing
  // the drag changes, or every memoised row would re-render per row crossed.
  const [dragActive, setDragActive] = useState(false)
  const [dropMark, setDropMark] = useState<DropMark | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const dropMarkRef = useRef<DropMark | null>(null)

  // Read at reply time, not captured at drop time: the queue can change hands during the IPC trip.
  const queueIdRef = useRef(playback.queueId)
  useEffect(() => {
    queueIdRef.current = playback.queueId
  }, [playback.queueId])

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

  // A source row that unmounts mid-drag never delivers its dragEnd, and the list would stay armed.
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
   * Lands the drag against the FULL view order; the list is redrawn only once the store accepts it.
   * When the reordered view IS the playing queue it reaches the engine at once, unlike a re-sort.
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
      // The payload is the playlist's FULL stored order: an id the library cannot resolve keeps
      // its place rather than wedging the reorder.
      const known = new Set(inView.map((song) => song.id))
      const stored = containingPlaylist?.songIds ?? []
      void window.api.playlists
        .reorderSongs(view.id, mergeReorderedIds(stored, ids, known))
        .then((playlist) => {
          dispatch({ type: 'playlists/upserted', playlist })
          if (queueIdRef.current === view.id) {
            dispatch({ type: 'queue/orderChanged', order: ids })
          }
        })
        .catch(fail)
        .finally(settle)
      return
    }
    void window.api.library
      .reorder(ids)
      .then(() => {
        dispatch({ type: 'library/reordered', order: ids })
        if (queueIdRef.current === LIBRARY_QUEUE_ID) {
          dispatch({ type: 'queue/orderChanged', order: ids })
        }
      })
      .catch(fail)
      .finally(settle)
  }, [endDrag, inView, view, containingPlaylist, dispatch, fail])

  /** The one gesture that moves the queue: outside the playing queue it hands it over, with the view's FULL order. */
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
    // The two fields, not the whole `settings`: the volume slider must not re-render every memoised row.
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

  /** `library.update` replaces `tags` wholesale, so the next list is computed here, not sent as a delta. */
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
    // The list's own handlers cover the 4px gaps between rows, where a release would otherwise be
    // lost; all three are ours-only, and the rows stopPropagation so a drop never double-fires.
    <ul
      className="song-list"
      aria-label="Songs"
      onDragOver={(event) => {
        // Only while a seam is painted: with no live mark the empty region is not a target.
        if (!dragActive || dropMarkRef.current === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!dragActive || dropMarkRef.current === null) return
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
