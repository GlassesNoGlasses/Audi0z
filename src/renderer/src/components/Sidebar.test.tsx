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

/** jsdom implements no drag pipeline, so the `DataTransfer` is hand-rolled. */
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

/** jsdom has no `DragEvent`, so the plain `Event` built instead needs its `clientY` put back. */
function dragOverAt(target: HTMLElement, dataTransfer: DataTransfer, clientY: number): void {
  const event = createEvent.dragOver(target, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}

const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.playlist-item')]

const itemNames = (): string[] =>
  items().map((li) => li.querySelector('.sidebar-entry')?.textContent ?? '')

/** One entry per row, so an empty list can never satisfy a "nothing is draggable" assertion. */
const draggableFlags = (): (string | null)[] => items().map((li) => li.getAttribute('draggable'))

describe('Sidebar', () => {
  /** The view and the queue are separate: browsing a playlist does not hand it the queue. */
  it('shows a playlist without disturbing what is playing', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))

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

  /** `aria-current` marks the entry being browsed; `is-playing-source` the one being heard. */
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
    // Independent axes, not exclusive: this entry is both the view browsed and the queue heard.
    expect(library).toHaveAttribute('aria-current', 'true')
    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).not.toHaveClass(
      'is-playing-source'
    )
  })

  /** Boot cues the library queue with nothing playing, which is not sound coming from it. */
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

  /** The sidebar's filter is its own: narrowing the playlist list must not move the songs. */
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

  /** Pinned outside the scrolling list, so no number of playlists can push it below the fold. */
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

  /** A filter chosen before the new name existed would hide the row the create just made. */
  it('clears the filter when the new playlist would not match it', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    const search = within(sidebar()).getByRole('searchbox', { name: 'Search playlists' })
    await user.type(search, 'mix')

    await user.click(within(sidebar()).getByRole('button', { name: 'New playlist' }))
    await user.type(screen.getByRole('textbox', { name: 'New playlist name' }), 'Late night')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Late night' })).toBeInTheDocument()
    )
    expect(search).toHaveValue('')
    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).toBeInTheDocument()
  })

  /** The other half of that rule: a filter the new name matches is doing its job, so it stays. */
  it('keeps the filter when the new playlist matches it', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    const search = within(sidebar()).getByRole('searchbox', { name: 'Search playlists' })
    await user.type(search, 'late')

    await user.click(within(sidebar()).getByRole('button', { name: 'New playlist' }))
    await user.type(screen.getByRole('textbox', { name: 'New playlist name' }), 'Late night')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Late night' })).toBeInTheDocument()
    )
    expect(search).toHaveValue('late')
    expect(within(sidebar()).queryByRole('button', { name: 'Mixes' })).not.toBeInTheDocument()
  })

  /** A create the store refused made nothing to make room for, so the filter is not spent. */
  it('keeps the filter when the playlist will not save', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [mixes] })
    vi.mocked(api.playlists.create).mockRejectedValue(new Error('playlists.json is read-only'))
    await renderApp()

    const search = within(sidebar()).getByRole('searchbox', { name: 'Search playlists' })
    await user.type(search, 'mix')

    await user.click(within(sidebar()).getByRole('button', { name: 'New playlist' }))
    await user.type(screen.getByRole('textbox', { name: 'New playlist name' }), 'Late night')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('playlists.json is read-only')
    expect(search).toHaveValue('mix')
    expect(within(sidebar()).getByRole('button', { name: 'Mixes' })).toBeInTheDocument()
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

    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat', 'Charlie Tune']))
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  /** The toggles persist to whichever store owns the queue, so a dead `queueId` breaks them. */
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

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  /** jsdom has no layout, so the drop target's rect — and with it its midpoint — is stubbed. */
  it('reorders playlists by dragging one below another', async () => {
    const api = seedApi({ songs, playlists: three })
    await renderApp()
    expect(itemNames()).toEqual(['Alpha', 'Bravo', 'Chill'])

    const [alpha, , chill] = items()
    chill.getBoundingClientRect = () =>
      ({ top: 40, height: 20, bottom: 60, left: 0, right: 100, width: 100, x: 0, y: 40 }) as DOMRect

    const dataTransfer = dataTransferStub()
    fireEvent.dragStart(alpha, { dataTransfer })
    // Either side of the row's midpoint: above it the seam is the top edge, below it the bottom.
    dragOverAt(chill, dataTransfer, 45)
    expect(chill.className).toContain('drop-before')
    dragOverAt(chill, dataTransfer, 55)
    expect(chill.className).toContain('drop-after')
    fireEvent.drop(chill, { dataTransfer })

    expect(api.playlists.reorder).toHaveBeenCalledWith(['p2', 'p3', 'p1'])
    // The list is the store's answer, not the guess the drag made.
    await waitFor(() => expect(itemNames()).toEqual(['Bravo', 'Chill', 'Alpha']))
    expect(items().some((li) => li.className.includes('drop-'))).toBe(false)
  })

  /** The drop path reads component state, so a payload would only feed the app's text inputs. */
  it('writes no payload into the dataTransfer', async () => {
    seedApi({ songs, playlists: three })
    await renderApp()

    const [alpha] = items()
    const dataTransfer = dataTransferStub()
    const setData = vi.spyOn(dataTransfer, 'setData')
    fireEvent.dragStart(alpha, { dataTransfer })

    expect(setData).not.toHaveBeenCalled()
  })

  /** A drag from the OS never hit the sidebar's `dragStart`, so the handlers leave it alone. */
  it('leaves a drag it never started completely alone', async () => {
    const api = seedApi({ songs, playlists: three })
    await renderApp()

    const [alpha] = items()
    const files = [new File(['x'], 'One Track.mp3', { type: 'audio/mpeg' })]
    const dataTransfer = { files, types: ['Files'] } as unknown as DataTransfer

    dragOverAt(alpha, dataTransfer, 45)

    expect(items().some((li) => li.className.includes('drop-'))).toBe(false)

    const dropped = createEvent.drop(alpha, { dataTransfer })
    fireEvent(alpha, dropped)

    // Untouched: a row that had taken this drag would have cancelled the event here.
    expect(dropped.defaultPrevented).toBe(false)
    expect(api.playlists.reorder).not.toHaveBeenCalled()
    expect(itemNames()).toEqual(['Alpha', 'Bravo', 'Chill'])
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

  /** The rule generalises: a rename that moves the row out of the filter spends the filter too. */
  it('clears the filter when a rename moves a playlist out of it', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes, playlist('p2', 'Late night', [])] })
    await renderApp()

    const search = within(sidebar()).getByRole('searchbox', { name: 'Search playlists' })
    await user.type(search, 'mix')
    expect(within(sidebar()).queryByRole('button', { name: 'Late night' })).not.toBeInTheDocument()

    await user.click(within(sidebar()).getByRole('button', { name: 'Rename Mixes' }))
    const input = screen.getByRole('textbox', { name: 'Playlist name' })
    await user.clear(input)
    await user.type(input, 'Mashups')
    await user.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Mashups' })).toBeInTheDocument()
    )
    expect(search).toHaveValue('')
    expect(within(sidebar()).getByRole('button', { name: 'Late night' })).toBeInTheDocument()
  })
})
