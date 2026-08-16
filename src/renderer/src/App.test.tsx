import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../tests/support/mockApi'
import {
  audioElement,
  nowPlaying,
  playSpy,
  renderApp,
  seedApi,
  song,
  songTitles,
  sortView,
  stubMediaElement
} from './testing/harness'

stubMediaElement()

/** A shortcut press. Nothing is focused by default, so the key arrives on the body. */
function press(key: string, target: Element = document.body): void {
  fireEvent.keyDown(target, { key })
}

/** Delete lives behind the row's ⋯ menu, and asks the global confirm dialog first. */
async function askToDelete(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: `Options for ${title}` }))
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }))
}

describe('App shell', () => {
  it('renders the app name', async () => {
    seedApi()
    await renderApp()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Audi0z')
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

    await askToDelete(user, 'Alpha Mix')
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

    await askToDelete(user, 'Alpha Mix')
    act(() => {
      controls.emitError({ source: 'trash', message: 'library.json is read-only' })
    })
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert')).toHaveTextContent('library.json is read-only')
    expect(songTitles()).toEqual(['Alpha Mix'])
  })
})

describe('App sorting', () => {
  const byDate = [
    song('a', 'Alpha Mix', { addedAt: '2024-01-01T00:00:00.000Z' }),
    song('b', 'Bravo Beat', { addedAt: '2024-02-01T00:00:00.000Z' }),
    song('c', 'Charlie Tune', { addedAt: '2024-03-01T00:00:00.000Z' })
  ]

  /**
   * The whole point of sorting in `songsInView`: the queue re-sync applies the same order, so what
   * plays next is what the list now shows. Sorting is not a queue switch, though — it reorders
   * around the song already playing rather than restarting it.
   */
  it('reorders the playing queue behind the song that is playing', async () => {
    const user = userEvent.setup()
    seedApi({ songs: byDate })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Play Library' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    // Twice: the first press is ascending, which this library is already in.
    await sortView(user, /Date added$/, 2)

    expect(songTitles()).toEqual(['Charlie Tune', 'Bravo Beat', 'Alpha Mix'])
    expect(nowPlaying()).toBe('Alpha Mix')

    // Alpha Mix is the last of the new order, so next wraps to the top of it — under the old
    // queue it would have been Bravo Beat.
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(nowPlaying()).toBe('Charlie Tune')
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

  /**
   * Since v3.1 the click itself hands focus back to the body, so space reaches the transport
   * rather than the row's own button — the state the replay bug lived in is now unreachable by
   * mouse. A play-token bump is what re-runs `useAudioElement`'s load effect, so an unmoved
   * `play()` count is the proof that space paused the song rather than starting it from the top.
   */
  it('space after clicking a song pauses it rather than replaying it', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    // v3.1: a mouse click no longer parks focus on the row — the shortcuts own the keyboard.
    expect(document.activeElement).toBe(document.body)
    const plays = playSpy().mock.calls.length

    await user.keyboard(' ')

    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(playSpy()).toHaveBeenCalledTimes(plays)
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

  /**
   * The click drops focus to the body, which is where the arrows are actually pressed. jsdom never
   * reports a duration, so only the lower clamp is in play here — and it is the one that matters:
   * three presses past the start must not leave the element at a negative time.
   */
  it('arrow keys skip ten seconds either way, clamped at the start', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    const audio = audioElement()
    audio.currentTime = 15

    await user.keyboard('{ArrowRight}')
    expect(audio.currentTime).toBe(25)

    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(audio.currentTime).toBe(0)

    // Element-local: the store never hears about a seek, so the transport still reads as playing.
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('leaves the arrows alone with nothing cued', async () => {
    seedApi({ songs })
    await renderApp()
    const audio = audioElement()
    audio.currentTime = 5

    press('ArrowRight')

    expect(audio.currentTime).toBe(5)
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
