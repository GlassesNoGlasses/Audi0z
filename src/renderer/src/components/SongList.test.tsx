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
