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
