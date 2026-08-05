import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
