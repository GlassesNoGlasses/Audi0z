import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import {
  playlist,
  renderApp,
  seedApi,
  sidebar,
  song,
  songTitles,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const songs = [
  song('a', 'Alpha Mix', { durationSec: 173 }),
  song('b', 'Bravo Beat'),
  song('c', 'Charlie Tune')
]

const mixes = playlist('p1', 'Mixes', ['b'])

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Add to Mixes' })
}

/** The titles the dialog is offering, in the order it offers them. */
function offered(): string[] {
  return [...dialog().querySelectorAll('.add-title')].map((el) => el.textContent ?? '')
}

/**
 * Opens the dialog the way the app does: move to the playlist, then ask the top bar for it.
 * Everything downstream needs the app around it — the sidebar and the row list are half the point.
 */
async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await renderApp()
  await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
  await user.click(screen.getByRole('button', { name: 'Add songs to Mixes' }))
  return user
}

describe('AddToPlaylistDialog', () => {
  it('offers the library the playlist lacks, whichever playlist is being viewed', async () => {
    seedApi({ songs, playlists: [mixes] })
    await openDialog()

    // Everything the library holds except Bravo Beat, which Mixes already has.
    expect(offered()).toEqual(['Alpha Mix', 'Charlie Tune'])
    // The playing time is the only thing beside the title, and it is the one the song knows.
    expect(within(dialog()).getByText('2:53')).toBeInTheDocument()
  })

  it('searches without touching the search the library is already under', async () => {
    seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()

    await user.type(screen.getByRole('searchbox', { name: 'Search songs to add' }), 'charlie')

    await waitFor(() => expect(offered()).toEqual(['Charlie Tune']))
    // The list behind the dialog is the playlist, unfiltered, and the app's own box is still empty.
    expect(songTitles()).toEqual(['Bravo Beat'])
    expect(screen.getByRole('searchbox', { name: 'Search songs' })).toHaveValue('')
  })

  it('says so when nothing matches', async () => {
    seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()

    await user.type(screen.getByRole('searchbox', { name: 'Search songs to add' }), 'zzz')

    expect(await within(dialog()).findByText('No songs match your search.')).toBeInTheDocument()
  })

  /** Nothing was searched for, so "nothing matched" would be a report on a search never made. */
  it('says the library is empty rather than blaming a search nobody ran', async () => {
    seedApi({ songs: [], playlists: [playlist('p1', 'Mixes', [])] })
    await openDialog()

    expect(within(dialog()).getByText('No songs in your library yet.')).toBeInTheDocument()
    expect(within(dialog()).queryByText('No songs match your search.')).toBeNull()
  })

  /** An empty list with a full library is a different fact, and gets a different sentence. */
  it('says so when every song is already in the playlist', async () => {
    seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b', 'c'])] })
    await openDialog()

    expect(
      within(dialog()).getByText('Every song is already in this playlist.')
    ).toBeInTheDocument()
    expect(within(dialog()).queryByText('No songs in your library yet.')).toBeNull()
  })

  /** Same again one level down: the search found songs, the playlist just has all of them. */
  it('says so when every match is already in the playlist', async () => {
    seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()

    await user.type(screen.getByRole('searchbox', { name: 'Search songs to add' }), 'bravo')

    expect(
      await within(dialog()).findByText('Every match is already in this playlist.')
    ).toBeInTheDocument()
    expect(within(dialog()).queryByText('No songs match your search.')).toBeNull()
  })

  it('adds a song, takes its row away and puts it in the playlist', async () => {
    const api = seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()

    await user.click(within(sidebar()).getByRole('button', { name: 'Expand Mixes' }))
    expect(within(sidebar()).queryByText('Alpha Mix')).toBeNull()

    await user.click(within(dialog()).getByRole('button', { name: 'Add Alpha Mix to Mixes' }))

    expect(api.playlists.addSong).toHaveBeenCalledWith('p1', 'a')
    await waitFor(() => expect(within(dialog()).queryByText('Alpha Mix')).toBeNull())
    expect(offered()).toEqual(['Charlie Tune'])
    // The playlist really took it: the sidebar and the list behind the dialog both say so.
    expect(within(sidebar()).getByText('Alpha Mix')).toBeInTheDocument()
    expect(songTitles()).toEqual(['Bravo Beat', 'Alpha Mix'])
  })

  /** The backend is idempotent, but a "+" that does nothing is a "+" that looks broken. */
  it('has nothing to offer on a song the playlist already has', async () => {
    seedApi({ songs, playlists: [mixes] })
    await openDialog()

    expect(within(dialog()).queryByText('Bravo Beat')).toBeNull()
  })

  it('says so when the playlist will not take the song', async () => {
    const api = seedApi({ songs, playlists: [mixes] })
    vi.mocked(api.playlists.addSong).mockRejectedValue(new Error('playlists.json is read-only'))
    const user = await openDialog()

    await user.click(within(dialog()).getByRole('button', { name: 'Add Alpha Mix to Mixes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('playlists.json is read-only')
    // Still offered, so the failure can be retried.
    expect(within(dialog()).getByRole('button', { name: 'Add Alpha Mix to Mixes' })).toBeEnabled()
  })

  it('closes on the ✕', async () => {
    seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()

    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog', { name: 'Add to Mixes' })).toBeNull()
  })

  it('closes on Escape', async () => {
    seedApi({ songs, playlists: [mixes] })
    const user = await openDialog()
    expect(dialog()).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Add to Mixes' })).toBeNull()
  })

  /** Nothing left to add to: a dialog about a playlist that is gone has to get out of the way. */
  it('closes itself when the playlist it is about disappears', async () => {
    const api = seedApi({ songs, playlists: [mixes] })
    const controls = mockApiControls(api)
    await openDialog()
    expect(dialog()).toBeInTheDocument()

    controls.state.playlists = []
    await act(async () => {
      controls.emitLibraryChanged()
    })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to Mixes' })).toBeNull())
  })
})
