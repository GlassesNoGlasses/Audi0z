import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp, seedApi, song, songTitles, stubMediaElement } from '../testing/harness'

stubMediaElement()

const songs = [
  song('a', 'Alpha Mix', { tags: ['slowed'] }),
  song('b', 'Bravo Beat'),
  song('c', 'Charlie Tune')
]

function searchBox(): HTMLElement {
  return screen.getByRole('searchbox', { name: 'Search songs' })
}

describe('SearchBox', () => {
  it('filters the song list as you type and restores it when cleared', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()
    expect(songTitles()).toHaveLength(3)

    await user.type(searchBox(), 'bravo')
    // `waitFor` rather than a bare assertion: the query is debounced.
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat']))

    await user.clear(searchBox())
    await waitFor(() => expect(songTitles()).toHaveLength(3))
  })

  it('matches tags as well as titles', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.type(searchBox(), 'slowed')
    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix']))
  })
})
