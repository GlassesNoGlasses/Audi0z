import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  nowPlaying,
  renderApp,
  seedApi,
  song,
  songTitles,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

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
})
