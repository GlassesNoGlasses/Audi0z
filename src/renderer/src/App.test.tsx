import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

/** A shortcut press. Nothing is focused by default, so the key arrives on the body. */
function press(key: string, target: Element = document.body): void {
  fireEvent.keyDown(target, { key })
}

describe('App shell', () => {
  it('renders the app name', async () => {
    seedApi()
    await renderApp()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('my-music-library')
  })

  /**
   * The registry is loaded and re-loaded alongside the songs: a tag renamed or deleted anywhere
   * cascades through the songs, so the two have to be read together or the chips and the rows
   * disagree.
   */
  it('reads the tag registry at start-up and again when the library changes', async () => {
    const api = seedApi({ tags: [{ id: 't1', name: 'slowed', color: '#5ca8e0' }] })
    const controls = mockApiControls(api)
    await renderApp()
    expect(api.tags.list).toHaveBeenCalledTimes(1)

    await act(async () => {
      controls.emitLibraryChanged()
    })

    await waitFor(() => expect(api.tags.list).toHaveBeenCalledTimes(2))
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

  /**
   * Main reports the trash failure on its error channel AND rejects the `invoke`, and its report
   * lands first. The renderer's own message is the only one that says the song survived, so it has
   * to be shown alongside main's rather than collapsed into it.
   */
  it('says the song survived when the trash refuses it', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const controls = mockApiControls(api)
    vi.mocked(api.library.remove).mockRejectedValue(
      new Error(
        "Error invoking remote method 'library:remove': Error: Failed to move item to trash"
      )
    )
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Delete Alpha Mix' }))
    // Main gets there first, exactly as `withErrorReport` does in the real process.
    act(() => {
      controls.emitError({ source: 'trash', message: 'Failed to move item to trash' })
    })
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const toasts = await screen.findAllByRole('alert')
    expect(toasts.map((toast) => toast.textContent)).toEqual([
      expect.stringContaining('Failed to move item to trash'),
      expect.stringContaining('the song is still in your library')
    ])
    expect(songTitles()).toEqual(['Alpha Mix'])
  })

  /**
   * The other half of the same pathway: when the renderer has nothing to add, both reports
   * normalise to the same sentence, and saying it twice only pushes the useful lines off the top.
   */
  it('says a failure once when main and the rejected invoke report it identically', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const controls = mockApiControls(api)
    vi.mocked(api.library.remove).mockRejectedValue(
      new Error("Error invoking remote method 'library:remove': Error: library.json is read-only")
    )
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Delete Alpha Mix' }))
    act(() => {
      controls.emitError({ source: 'trash', message: 'library.json is read-only' })
    })
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert')).toHaveTextContent('library.json is read-only')
    expect(songTitles()).toEqual(['Alpha Mix'])
  })
})

describe('App keyboard shortcuts', () => {
  const songs = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')]

  it('plays and pauses the cued song with the space bar', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

    press(' ')
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()

    press(' ')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  it('leaves a cold queue alone — space resumes, it does not choose a song', async () => {
    seedApi({ songs })
    await renderApp()

    press(' ')

    expect(nowPlaying()).toBe('Nothing playing')
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('stays out of the way while a dialog is open', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    press(' ')
    press('m')

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(audioElement().volume).toBe(1)
  })

  it('stays out of the way while the user is typing', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    const search = screen.getByRole('searchbox', { name: 'Search songs' })

    press(' ', search)
    press('m', search)

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(audioElement().volume).toBe(1)
  })

  it('mutes and unmutes with m, restoring the volume it was at', async () => {
    const api = seedApi({ songs, settings: { volume: 0.7 } })
    await renderApp()
    expect(audioElement().volume).toBe(0.7)

    press('m')

    await waitFor(() => expect(api.settings.set).toHaveBeenLastCalledWith({ volume: 0 }))
    expect(audioElement().volume).toBe(0)
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('0')

    press('m')

    // Back to 0.7, not to full — the ref remembers what was audible last.
    await waitFor(() => expect(api.settings.set).toHaveBeenLastCalledWith({ volume: 0.7 }))
    expect(audioElement().volume).toBe(0.7)
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('0.7')
  })

  it('says so when the muted volume cannot be persisted', async () => {
    const api = seedApi({ songs })
    vi.mocked(api.settings.set).mockRejectedValue(new Error('settings.json is read-only'))
    await renderApp()

    press('m')

    expect(await screen.findByRole('alert')).toHaveTextContent('settings.json is read-only')
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
