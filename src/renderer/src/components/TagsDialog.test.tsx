import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '../../../shared/api'
import { renderApp, seedApi, song, stubMediaElement } from '../testing/harness'

stubMediaElement()

const tags = [
  { id: 't1', name: 'slowed', color: '#e0a35c' },
  { id: 't2', name: 'reverb', color: '#3b2f8f' }
]

/** Tag chips as the song rows behind the dialog show them. A row with none draws none. */
function songTags(): string[] {
  return [...document.querySelectorAll('.song-list .song-tag')].map((el) => el.textContent ?? '')
}

/**
 * Main does not announce a library change when a tag is renamed or removed — only the dialog's own
 * refresh puts the cascade on screen. Silencing the push proves the refresh is doing that work,
 * rather than the mock's (more generous) event.
 */
function withoutLibraryPush(api: Api): void {
  vi.mocked(api.events.onLibraryChanged).mockReturnValue(() => {})
}

async function openTags(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await renderApp()
  await user.click(screen.getByRole('button', { name: 'Tags' }))
  return user
}

describe('TagsDialog', () => {
  it('shows every tag as a chip in its own colour, in ink that can be read on it', async () => {
    seedApi({ tags })
    await openTags()

    expect(screen.getByText('slowed').parentElement).toHaveStyle({
      backgroundColor: '#e0a35c',
      color: '#000000'
    })
    expect(screen.getByText('reverb').parentElement).toHaveStyle({
      backgroundColor: '#3b2f8f',
      color: '#ffffff'
    })
  })

  it('says so when there are none', async () => {
    seedApi()
    await openTags()
    expect(screen.getByText('No tags yet.')).toBeInTheDocument()
  })

  it('creates a tag and shows it straight away', async () => {
    const api = seedApi()
    const user = await openTags()

    await user.type(screen.getByRole('textbox', { name: 'New tag name' }), 'slowed')
    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    expect(api.tags.create).toHaveBeenCalledWith('slowed')
    expect(await screen.findByText('slowed')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'New tag name' })).toHaveValue('')
  })

  it('has nothing to create from an empty name', async () => {
    const api = seedApi()
    const user = await openTags()

    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    expect(api.tags.create).not.toHaveBeenCalled()
  })

  it('says so when the name is taken', async () => {
    seedApi({ tags })
    const user = await openTags()

    await user.type(screen.getByRole('textbox', { name: 'New tag name' }), 'Slowed')
    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A tag named "slowed" already exists'
    )
  })

  it('renames a tag, and every song carrying it', async () => {
    const api = seedApi({ tags, songs: [song('a', 'Alpha Mix', { tags: ['slowed'] })] })
    withoutLibraryPush(api)
    const user = await openTags()
    expect(songTags()).toEqual(['slowed'])

    await user.click(screen.getByRole('button', { name: 'Rename tag slowed' }))
    await user.clear(screen.getByRole('textbox', { name: 'Tag name' }))
    await user.type(screen.getByRole('textbox', { name: 'Tag name' }), 'chopped')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.tags.rename).toHaveBeenCalledWith('t1', 'chopped')
    expect(await screen.findByRole('button', { name: 'Rename tag chopped' })).toBeInTheDocument()
    expect(songTags()).toEqual(['chopped'])
  })

  it('deletes a tag once, and only once, it is confirmed', async () => {
    const api = seedApi({ tags, songs: [song('a', 'Alpha Mix', { tags: ['slowed'] })] })
    withoutLibraryPush(api)
    const user = await openTags()

    await user.click(screen.getByRole('button', { name: 'Delete tag slowed' }))
    expect(
      screen.getByText('Delete tag "slowed"? It will be removed from every song.')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.tags.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete tag slowed' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete tag slowed' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.tags.remove).toHaveBeenCalledWith('t1')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete tag slowed' })).toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Delete tag reverb' })).toBeInTheDocument()
    // The cascade reached the row: the chip it was drawing is gone with the tag.
    expect(songTags()).toEqual([])
  })

  it('says so when a tag cannot be deleted', async () => {
    const api = seedApi({ tags })
    vi.mocked(api.tags.remove).mockRejectedValue(new Error('tags.json is read-only'))
    const user = await openTags()

    await user.click(screen.getByRole('button', { name: 'Delete tag slowed' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('tags.json is read-only')
    expect(screen.getByText('slowed')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    seedApi({ tags })
    const user = await openTags()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Tags' })).toBeNull()
  })
})
