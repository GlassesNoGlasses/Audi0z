import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  nowPlaying,
  playlist,
  renderApp,
  seedApi,
  sidebar,
  song,
  songTitles,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const songs = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
const mixes = playlist('p1', 'Mixes', ['c', 'a'], { shuffle: true })

/** Three to drag between: two would make every reorder the same move. */
const three = [
  playlist('p1', 'Alpha', []),
  playlist('p2', 'Bravo', []),
  playlist('p3', 'Chill', [])
]

/**
 * jsdom implements no drag pipeline, so the `DataTransfer` the handlers write to is hand-rolled —
 * only the two methods and two properties the sidebar touches.
 */
function dataTransferStub(): DataTransfer {
  const store: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => {
      store[type] = value
    },
    getData: (type: string) => store[type] ?? ''
  } as unknown as DataTransfer
}

/**
 * jsdom has no `DragEvent` constructor either, so testing-library builds a plain `Event` — which
 * drops `clientY`, the one coordinate the drop edge is decided from. Put it back by hand.
 */
function dragOverAt(target: HTMLElement, dataTransfer: DataTransfer, clientY: number): void {
  const event = createEvent.dragOver(target, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}

const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.playlist-item')]

/** The playlist names in sidebar order — what a reorder is supposed to change. */
const itemNames = (): string[] =>
  items().map((li) => li.querySelector('.sidebar-entry')?.textContent ?? '')

/** One entry per row, so an empty list can never satisfy a "nothing is draggable" assertion. */
const draggableFlags = (): (string | null)[] => items().map((li) => li.getAttribute('draggable'))

describe('Sidebar', () => {
  /**
   * The view and the queue are separate things. Moving around the sidebar to see what is in a
   * playlist is not a request to stop the music, so it does not — the queue only changes when the
   * user plays something from the view they moved to.
   */
  it('shows a playlist without disturbing what is playing', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))

    // The playlist is on screen in its own order, and playback carried straight on.
    expect(songTitles()).toEqual(['Charlie Tune', 'Alpha Mix'])
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    // Still the library's toggles: the playlist is only being looked at, not played.
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('hands the queue over to the viewed playlist once a song in it is played', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Charlie Tune' }))

    expect(nowPlaying()).toBe('Charlie Tune')
    // The playlist's own toggles come with it.
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'true')
  })

  /**
   * The other half of that split, drawn rather than merely honoured: `aria-current` says which
   * entry is being BROWSED, and the marker below says which one the sound is coming from. They are
   * independent axes, so a test that only ever looked at a view whose queue it also owned would
   * not be able to tell the two apart.
   */
  it('marks the playlist the sound is coming from, not the one being browsed', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [playlist('p1', 'Late night', ['a'])] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Late night' }))
    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(within(sidebar()).getByRole('button', { name: 'Library' }))

    const entry = within(sidebar()).getByRole('button', { name: 'Late night' })
    expect(entry).toHaveClass('is-playing-source')
    expect(entry).not.toHaveAttribute('aria-current')

    const library = within(sidebar()).getByRole('button', { name: 'Library' })
    expect(library).not.toHaveClass('is-playing-source')
    expect(library).toHaveAttribute('aria-current', 'true')
  })

  it('marks the Library entry when the library itself is the queue', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))

    const library = within(sidebar()).getByRole('button', { name: 'Library' })
    expect(library).toHaveClass('is-playing-source')
    // The two axes are independent, not exclusive: the library is both the view being browsed and
    // the queue being heard, so one entry carries both marks at once.
    expect(library).toHaveAttribute('aria-current', 'true')
    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).not.toHaveClass(
      'is-playing-source'
    )
  })

  /**
   * Boot cues the library queue unconditionally, with nothing playing. Marking the entry then would
   * claim sound is coming from a library nobody has pressed play on yet.
   */
  it('marks nothing while the queue is only cued at boot', async () => {
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    expect(nowPlaying()).toBe('Nothing playing')
    expect(document.querySelector('.is-playing-source')).toBeNull()
  })

  it('expands a playlist without disturbing the queue', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(within(sidebar()).getByRole('button', { name: 'Expand Mixes' }))

    expect(within(sidebar()).getByText('Charlie Tune')).toBeInTheDocument()
    expect(within(sidebar()).getByRole('button', { name: 'Collapse Mixes' })).toBeInTheDocument()
    // Still the library queue, still playing the same song.
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'false')
  })

  /** An expanded playlist that renders nothing reads as broken rather than as empty. */
  it('says so when an expanded playlist has nothing in it', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [playlist('p2', 'Later', [])] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Expand Later' }))

    expect(within(sidebar()).getByText('playlist is empty')).toBeInTheDocument()
  })

  /**
   * The sidebar's filter is its own. The app's search box says what the user is browsing, so
   * narrowing the playlist list must leave the songs underneath exactly where they were.
   */
  it('filters the playlist list by name, case-insensitively', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes, playlist('p2', 'Late night', [])] })
    await renderApp()

    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search playlists' }), 'mix')

    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).toBeInTheDocument()
    expect(within(sidebar()).queryByRole('button', { name: 'Late night' })).not.toBeInTheDocument()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])

    await user.clear(within(sidebar()).getByRole('searchbox', { name: 'Search playlists' }))

    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).toBeInTheDocument()
    expect(within(sidebar()).getByRole('button', { name: 'Late night' })).toBeInTheDocument()
  })

  /** A list that just empties reads as though the playlists went away, not as a filter that bit. */
  it('says so when no playlist matches', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.type(
      within(sidebar()).getByRole('searchbox', { name: 'Search playlists' }),
      'nothing'
    )

    expect(within(sidebar()).getByText('no playlists match')).toBeInTheDocument()
    expect(within(sidebar()).queryByRole('button', { name: 'Mixes' })).not.toBeInTheDocument()
  })

  /**
   * Pinned to the panel's edge rather than trailing the list: the playlists scroll past it, so no
   * number of playlists can push the one way of making another below the fold.
   */
  it('keeps the new playlist button outside the scrolling list', async () => {
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    const create = within(sidebar()).getByRole('button', { name: 'New playlist' })

    expect(create.closest('.sidebar-nav')).toBeNull()
  })

  it('creates a playlist', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'New playlist' }))
    await user.type(screen.getByRole('textbox', { name: 'New playlist name' }), 'Late night')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(api.playlists.create).toHaveBeenCalledWith('Late night')
    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Late night' })).toBeInTheDocument()
    )
  })

  it('deletes a playlist after confirmation and leaves its songs in the library', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Delete playlist Mixes' }))
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toHaveTextContent(
      'Delete the playlist "Mixes"?'
    )
    expect(api.playlists.remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.playlists.remove).toHaveBeenCalledWith('p1')
    await waitFor(() =>
      expect(within(sidebar()).queryByRole('button', { name: 'Mixes' })).not.toBeInTheDocument()
    )
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])
  })

  it('keeps playing when a playlist that was only being viewed is deleted', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))

    await user.click(within(sidebar()).getByRole('button', { name: 'Delete playlist Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // The view has nowhere to be but the library; the queue was never the playlist's to take.
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune']))
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  /**
   * The complement of the test above: here the deleted playlist IS the queue. Leaving `queueId`
   * pointing at it would leave the transport driving a playlist that no longer exists — the toggles
   * persist to whichever store owns the queue, so shuffle would be written to a dead id and fail.
   */
  it('stops the queue and keeps the toggles quiet when the playing playlist is deleted', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [mixes] })
    await renderApp()

    // Viewing the playlist is not enough — playing something in it is what makes it the queue.
    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Charlie Tune' }))
    expect(nowPlaying()).toBe('Charlie Tune')

    await user.click(within(sidebar()).getByRole('button', { name: 'Delete playlist Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(nowPlaying()).toBe('Nothing playing'))
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Shuffle' }))

    expect(api.playlists.setPlaybackOptions).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()

    // Empty, not broken: the library is still one click away from being the queue again.
    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  /**
   * jsdom has no layout either, so the row's rect is stubbed: the edge the drop lands on is decided
   * against the row's own midpoint, and a stubbed rect is what makes that midpoint a real number.
   */
  it('reorders playlists by dragging one below another', async () => {
    const api = seedApi({ songs, playlists: three })
    await renderApp()
    expect(itemNames()).toEqual(['Alpha', 'Bravo', 'Chill'])

    const [alpha, , chill] = items()
    chill.getBoundingClientRect = () =>
      ({ top: 40, height: 20, bottom: 60, left: 0, right: 100, width: 100, x: 0, y: 40 }) as DOMRect

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    // Either side of the row's own midpoint: above it the seam is the row's top edge, below it the
    // bottom one, and the same pointer position must not mean both.
    dragOverAt(chill, dataTransfer, 45)
    expect(chill.className).toContain('drop-before')
    dragOverAt(chill, dataTransfer, 55)
    expect(chill.className).toContain('drop-after')
    fireEvent.drop(chill, { dataTransfer })

    expect(api.playlists.reorder).toHaveBeenCalledWith(['p2', 'p3', 'p1'])
    // The list is the store's answer, not the guess the drag made — nothing moves until it lands.
    await waitFor(() => expect(itemNames()).toEqual(['Bravo', 'Chill', 'Alpha']))
    expect(items().some((li) => li.className.includes('drop-'))).toBe(false)
  })

  /**
   * A file dragged in from the OS never went through the sidebar's own `dragStart`, so `dragId` is
   * still null and every handler on the row has to leave the event completely alone. The proof is
   * that the drop arrives at the app root's handler and opens the add dialog: the sidebar's `onDrop`
   * calls `stopPropagation`, so a row that had taken this drag would have swallowed it here.
   */
  it('lets a drag it never started fall through to the app root', async () => {
    const api = seedApi({ songs, playlists: three })
    await renderApp()

    const [alpha] = items()
    const files = [new File(['x'], 'One Track.mp3', { type: 'audio/mpeg' })]
    const dataTransfer = { files, types: ['Files'] } as unknown as DataTransfer

    dragOverAt(alpha, dataTransfer, 45)

    // No seam drawn: the row is not offering to receive anything.
    expect(items().some((li) => li.className.includes('drop-'))).toBe(false)

    await act(async () => {
      fireEvent.drop(alpha, { dataTransfer })
    })

    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
    expect(api.playlists.reorder).not.toHaveBeenCalled()
  })

  /** The store is the order of record, so a reorder it refused must leave the list where it was. */
  it('says so and keeps the old order when the reorder will not save', async () => {
    const api = seedApi({ songs, playlists: three })
    vi.mocked(api.playlists.reorder).mockRejectedValue(new Error('playlists.json is read-only'))
    await renderApp()

    const [alpha, , chill] = items()
    chill.getBoundingClientRect = () =>
      ({ top: 40, height: 20, bottom: 60, left: 0, right: 100, width: 100, x: 0, y: 40 }) as DOMRect

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    dragOverAt(chill, dataTransfer, 55)
    fireEvent.drop(chill, { dataTransfer })

    expect(await screen.findByRole('alert')).toHaveTextContent('playlists.json is read-only')
    expect(itemNames()).toEqual(['Alpha', 'Bravo', 'Chill'])
    // The drag is over either way — the failure must not leave a seam painted on the list.
    expect(items().some((li) => li.className.includes('drop-'))).toBe(false)
  })

  /** Reordering a filtered subset is ambiguous: nothing says where the hidden ones end up. */
  it('does not drag while the filter narrows the list', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: three })
    await renderApp()
    expect(draggableFlags()).toEqual(['true', 'true', 'true'])

    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search playlists' }), 'a')

    expect(itemNames()).toEqual(['Alpha', 'Bravo'])
    expect(draggableFlags()).toEqual(['false', 'false'])
  })

  /** The rename field lives inside the row: a draggable row would fight selecting its own text. */
  it('does not drag while a playlist is being renamed', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: three })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Rename Alpha' }))

    // Every row, not just the one being renamed: the list is mid-edit, so none of it may move.
    expect(draggableFlags()).toEqual(['false', 'false', 'false'])
  })

  it('renames a playlist', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Rename Mixes' }))
    const input = screen.getByRole('textbox', { name: 'Playlist name' })
    await user.clear(input)
    await user.type(input, 'Mashups')
    await user.click(screen.getByRole('button', { name: 'Save name' }))

    expect(api.playlists.rename).toHaveBeenCalledWith('p1', 'Mashups')
    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Mashups' })).toBeInTheDocument()
    )
  })
})
