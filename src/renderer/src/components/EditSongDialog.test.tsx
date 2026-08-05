import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import {
  audioElement,
  renderApp,
  seedApi,
  song,
  songTitles,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const songs = [song('a', 'Alpha Mix', { tags: ['slowed'] }), song('b', 'Bravo Beat')]

const registry = [{ id: 't1', name: 'slowed', color: '#e0a35c' }]

/** Edit is reached through the row's ⋯ menu. */
async function openEdit(title: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await renderApp()
  await user.click(screen.getByRole('button', { name: `Options for ${title}` }))
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }))
  return user
}

describe('EditSongDialog', () => {
  it('saves the title, and re-renders from what the api returned', async () => {
    const api = seedApi({ songs, tags: registry })
    const user = await openEdit('Alpha Mix')

    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Alpha Mix (slowed)')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.library.update).toHaveBeenCalledWith('a', { title: 'Alpha Mix (slowed)' })
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix (slowed)', 'Bravo Beat']))
    expect(screen.queryByRole('dialog', { name: 'Edit song' })).not.toBeInTheDocument()
  })

  /** Which tags a song carries is the row menu's job now, and which tags EXIST is the Tags dialog's. */
  it('has nothing to say about tags, and leaves the ones the song carries alone', async () => {
    const api = seedApi({ songs, tags: registry })
    const user = await openEdit('Alpha Mix')

    expect(screen.queryByRole('textbox', { name: /Tags/ })).toBeNull()

    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' v2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.library.update).toHaveBeenCalledWith('a', { title: 'Alpha Mix v2' })
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix v2', 'Bravo Beat']))
    expect(screen.getByText('slowed')).toBeInTheDocument()
  })

  it('has nothing to save from an empty title', async () => {
    const api = seedApi({ songs })
    const user = await openEdit('Alpha Mix')

    await user.clear(screen.getByRole('textbox', { name: 'Title' }))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.library.update).not.toHaveBeenCalled()
  })

  it('closes on Escape, leaving the song untouched', async () => {
    const api = seedApi({ songs })
    const user = await openEdit('Alpha Mix')

    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' (slowed)')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Edit song' })).toBeNull()
    expect(api.library.update).not.toHaveBeenCalled()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
  })

  it('stays open and says so when the save fails', async () => {
    const api = seedApi({ songs })
    vi.mocked(api.library.update).mockRejectedValue(new Error('library.json is read-only'))
    const user = await openEdit('Alpha Mix')

    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('library.json is read-only')
    expect(screen.getByRole('dialog', { name: 'Edit song' })).toBeInTheDocument()
  })

  /**
   * Nothing left to edit: a dialog about a song that is gone has to get out of the way. The screen
   * goes blank on its own — the early return sees to that — so what is really being asserted is the
   * dialog slot being given up, and `m` reaching the player is the only way to see that from here.
   */
  it('closes itself when the song it is about disappears', async () => {
    const api = seedApi({ songs })
    const controls = mockApiControls(api)
    await openEdit('Alpha Mix')
    expect(screen.getByRole('dialog', { name: 'Edit song' })).toBeInTheDocument()

    controls.state.songs = []
    await act(async () => {
      controls.emitLibraryChanged()
    })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit song' })).toBeNull())
    // Nothing is focused once the dialog goes, so the shortcut arrives on the body.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'm' })
    })
    expect(audioElement().volume).toBe(0)
  })
})
