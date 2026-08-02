import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApiControls } from '../../../tests/support/mockApi'
import {
  audioElement,
  nowPlaying,
  renderApp,
  seedApi,
  song,
  songTitles,
  stubMediaElement
} from './testing/harness'

stubMediaElement()

describe('App shell', () => {
  it('renders the app name', async () => {
    seedApi()
    await renderApp()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('my-music-library')
  })

  it('refetches the library when the main process says it changed', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const controls = mockApiControls(api)
    await renderApp()
    expect(songTitles()).toEqual(['Alpha Mix'])

    controls.state.songs.push(song('b', 'Bravo Beat'))
    await act(async () => {
      controls.emitLibraryChanged()
    })

    await waitFor(() => expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat']))
  })

  it('skips past a song whose file cannot be played, flags it and says why', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await act(async () => {
      fireEvent.error(audioElement())
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Alpha Mix')
    expect(screen.getByText('File missing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha Mix' })).toBeDisabled()
    expect(nowPlaying()).toBe('Bravo Beat')
  })

  it('stops instead of cycling when nothing else in the queue can play', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await act(async () => {
      fireEvent.error(audioElement())
    })

    expect(nowPlaying()).toBe('Alpha Mix')
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })
})

describe('test harness', () => {
  it('runs against a mock window.api whose state a test can steer', async () => {
    const controls = mockApiControls(window.api)
    controls.state.settings.volume = 0.5

    await expect(window.api.library.list()).resolves.toEqual([])
    await expect(window.api.settings.get()).resolves.toMatchObject({ volume: 0.5 })
  })

  // Runs after the test above, which left volume at 0.5 — proves the setup file reinstalls a
  // fresh mock for every test rather than sharing one across the file.
  it('gets a fresh mock api, not the one the previous test mutated', async () => {
    await expect(window.api.settings.get()).resolves.toMatchObject({ volume: 1 })
  })
})
