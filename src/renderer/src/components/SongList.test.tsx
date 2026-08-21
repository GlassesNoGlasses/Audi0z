import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
  sortView,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const songs = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]

/**
 * jsdom implements no drag pipeline, so the `DataTransfer` the handlers write to is hand-rolled —
 * only the two methods and two properties the rows touch. Same stub the sidebar's drag tests use.
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

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.song-row')]

/** One entry per row, so an empty list can never satisfy a "nothing is draggable" assertion. */
const draggableFlags = (): (string | null)[] => rows().map((li) => li.getAttribute('draggable'))

/** jsdom has no layout, so the drop target's rect — and with it the midpoint — is stubbed. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () =>
    ({ top: 40, height: 20, bottom: 60, left: 0, right: 100, width: 100, x: 0, y: 40 }) as DOMRect
}

describe('SongList', () => {
  it('renders every song in the library', async () => {
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
  })

  it('says so when the library is empty', async () => {
    seedApi()
    await renderApp()
    expect(screen.getByText('No songs yet. Add one to get started.')).toBeInTheDocument()
  })

  it('marks a song whose file is gone and refuses to play it', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix', { exists: false }), song('b', 'Bravo Beat')] })
    await renderApp()

    const missing = screen.getByRole('button', { name: 'Alpha Mix' })
    expect(missing).toBeDisabled()
    expect(screen.getByText('File missing')).toBeInTheDocument()

    await user.click(missing)
    expect(nowPlaying()).toBe('Nothing playing')
  })

  it('switches the queue to the view when a row outside the playing queue is played', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['c', 'b'])] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Charlie Tune' }))

    expect(nowPlaying()).toBe('Charlie Tune')
    // The playlist's order is the queue now: after its head comes its second song, not the
    // library's wrap-around to Alpha Mix.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(nowPlaying()).toBe('Bravo Beat')
  })

  it('lists the library newest first once the sort asks for it', async () => {
    const user = userEvent.setup()
    seedApi({
      songs: [
        song('a', 'Alpha Mix', { addedAt: '2024-01-01T00:00:00.000Z' }),
        song('b', 'Bravo Beat', { addedAt: '2024-02-01T00:00:00.000Z' }),
        song('c', 'Charlie Tune', { addedAt: '2024-03-01T00:00:00.000Z' })
      ]
    })
    await renderApp()

    // Twice: the first press is ascending, which this library is already in.
    await sortView(user, /Date Added$/, 2)

    expect(songTitles()).toEqual(['Charlie Tune', 'Bravo Beat', 'Alpha Mix'])
  })

  /**
   * The backfill measures songs behind the list, so a library being sorted by playing time will
   * routinely hold some that have none yet. They go to the end rather than leading with a blank.
   */
  it('sinks a song with no playing time to the end of a duration sort', async () => {
    const user = userEvent.setup()
    seedApi({
      songs: [
        song('a', 'Alpha Mix', { durationSec: 200 }),
        song('b', 'Bravo Beat'),
        song('c', 'Charlie Tune', { durationSec: 100 })
      ]
    })
    await renderApp()

    await sortView(user, /Duration$/)

    expect(songTitles()).toEqual(['Charlie Tune', 'Alpha Mix', 'Bravo Beat'])
  })

  it('queues the whole view even when the search has filtered it down', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b', 'c'], { repeat: true })] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search songs' }), 'charlie')
    await waitFor(() => expect(songTitles()).toEqual(['Charlie Tune']))

    await user.click(screen.getByRole('button', { name: 'Charlie Tune' }))
    expect(nowPlaying()).toBe('Charlie Tune')
    // The playlist really is the queue now — it brought its own repeat flag along.
    expect(screen.getByRole('button', { name: 'Repeat' })).toHaveAttribute('aria-pressed', 'true')

    // One row is on screen, three are in the queue: next wraps round the whole playlist rather
    // than restarting the only visible song.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })
})

describe('SongList drag reorder', () => {
  it('reorders the library by dragging a row below another', async () => {
    const api = seedApi({ songs })
    await renderApp()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])

    const [alpha, , charlie] = rows()
    stubRect(charlie)
    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    // Either side of the row's own midpoint: above it the seam is the row's top edge, below it
    // the bottom one, and the same pointer position must not mean both.
    dragOverAt(charlie, dataTransfer, 45)
    expect(charlie.className).toContain('drop-before')
    dragOverAt(charlie, dataTransfer, 55)
    expect(charlie.className).toContain('drop-after')
    fireEvent.drop(charlie, { dataTransfer })

    expect(api.library.reorder).toHaveBeenCalledWith(['b', 'c', 'a'])
    // The list is the store's answer, not the guess the drag made — nothing moves until it lands.
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat', 'Charlie Tune', 'Alpha Mix']))
    expect(rows().some((li) => li.className.includes('drop-'))).toBe(false)
  })

  it('reorders a playlist through its own channel', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b', 'c'])] })
    await renderApp()
    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))

    const [alpha, , charlie] = rows()
    stubRect(charlie)
    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    dragOverAt(charlie, dataTransfer, 55)
    fireEvent.drop(charlie, { dataTransfer })

    // The playlist's own order moved — the library's stored order is not this write's business.
    expect(api.playlists.reorderSongs).toHaveBeenCalledWith('p1', ['b', 'c', 'a'])
    expect(api.library.reorder).not.toHaveBeenCalled()
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat', 'Charlie Tune', 'Alpha Mix']))
  })

  /** Dragging rearranges the stored order, which the rows only ARE under Custom Order. */
  it('drags only while Custom Order is the sort in force', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()
    expect(draggableFlags()).toEqual(['true', 'true', 'true'])

    await sortView(user, /Title$/)
    expect(draggableFlags()).toEqual(['false', 'false', 'false'])

    await sortView(user, 'Custom Order')
    expect(draggableFlags()).toEqual(['true', 'true', 'true'])
  })

  /** Reordering a filtered subset is ambiguous: nothing says where the hidden ones end up. */
  it('does not drag while the search narrows the list', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.type(screen.getByRole('searchbox', { name: 'Search songs' }), 'alpha')
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix']))

    expect(draggableFlags()).toEqual(['false'])
  })

  /**
   * A file dragged in from the OS never went through the list's own `dragStart`, so every handler
   * on the row has to leave the event completely alone: no seam, no reorder, and neither
   * `preventDefault` nor `stopPropagation` on the way past.
   */
  it('leaves a drag it never started completely alone', async () => {
    const api = seedApi({ songs })
    await renderApp()

    const [alpha] = rows()
    const files = [new File(['x'], 'One Track.mp3', { type: 'audio/mpeg' })]
    const dataTransfer = { files, types: ['Files'] } as unknown as DataTransfer

    dragOverAt(alpha, dataTransfer, 45)

    // No seam drawn: the row is not offering to receive anything.
    expect(rows().some((li) => li.className.includes('drop-'))).toBe(false)

    const dropped = createEvent.drop(alpha, { dataTransfer })
    fireEvent(alpha, dropped)

    // Untouched: a row that had taken this drag would have cancelled the event here.
    expect(dropped.defaultPrevented).toBe(false)
    expect(api.library.reorder).not.toHaveBeenCalled()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])
  })

  /** The store is the order of record, so a reorder it refused must leave the list where it was. */
  it('says so and keeps the old order when the reorder will not save', async () => {
    const api = seedApi({ songs })
    vi.mocked(api.library.reorder).mockRejectedValue(new Error('library.json is read-only'))
    await renderApp()

    const [alpha, , charlie] = rows()
    stubRect(charlie)
    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    dragOverAt(charlie, dataTransfer, 55)
    fireEvent.drop(charlie, { dataTransfer })

    expect(await screen.findByRole('alert')).toHaveTextContent('library.json is read-only')
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune'])
    // The drag is over either way — the failure must not leave a seam painted on the list.
    expect(rows().some((li) => li.className.includes('drop-'))).toBe(false)
  })
})
