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

const songs = [song('a', 'Alpha Mix', { tags: ['slowed'] }), song('b', 'Bravo Beat')]

describe('SongRow', () => {
  it('plays the song that was clicked', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Bravo Beat' }))

    expect(nowPlaying()).toBe('Bravo Beat')
    expect(screen.getByRole('button', { name: 'Bravo Beat' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('saves an edited title and tags, and re-renders from what the api returned', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Edit Alpha Mix' }))
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Alpha Mix (slowed)')
    const tags = screen.getByRole('textbox', { name: 'Tags (comma separated)' })
    await user.clear(tags)
    await user.type(tags, ' slowed , reverb ,')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.library.update).toHaveBeenCalledWith('a', {
      title: 'Alpha Mix (slowed)',
      tags: ['slowed', 'reverb']
    })
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix (slowed)', 'Bravo Beat']))
    expect(screen.queryByRole('dialog', { name: 'Edit song' })).not.toBeInTheDocument()
  })

  it('deletes a song only after confirmation, and clears it out of playback', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(screen.getByRole('button', { name: 'Delete Alpha Mix' }))
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toHaveTextContent(
      'Move "Alpha Mix" to the trash?'
    )
    expect(api.library.remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.library.remove).toHaveBeenCalledWith('a')
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat']))
    // `library/songsRemoved` reached the playback engine, not just the list.
    expect(nowPlaying()).toBe('Nothing playing')
  })

  it('adds a song to a playlist', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [playlist('p1', 'Mixes', [])] })
    await renderApp()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Add Alpha Mix to a playlist' }),
      'p1'
    )

    await waitFor(() => expect(api.playlists.addSong).toHaveBeenCalledWith('p1', 'a'))
  })

  it('takes a song out of the playlist it is being viewed in, keeping it in the library', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b'])] })
    await renderApp()

    // Only offered inside a playlist: in the Library there is nothing to remove it from.
    expect(screen.queryByRole('button', { name: 'Remove Alpha Mix from Mixes' })).toBeNull()

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Remove Alpha Mix from Mixes' }))

    expect(api.playlists.removeSong).toHaveBeenCalledWith('p1', 'a')
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat']))
    expect(api.library.remove).not.toHaveBeenCalled()

    await user.click(within(sidebar()).getByRole('button', { name: 'Library' }))
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
  })

  it('reveals the backing file in the file manager', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Reveal Alpha Mix' }))

    expect(api.library.revealInFolder).toHaveBeenCalledWith('a')
  })
})
