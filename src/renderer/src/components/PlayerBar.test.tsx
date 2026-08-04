import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  audioElement,
  nowPlaying,
  playlist,
  renderApp,
  seedApi,
  sidebar,
  song,
  stubDuration,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const songs = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]

describe('PlayerBar transport', () => {
  it('reflects and toggles the playing state', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  it('steps forward and back through the queue', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(nowPlaying()).toBe('Bravo Beat')

    await user.click(screen.getByRole('button', { name: 'Previous' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  it('starts the queue from cold when nothing has been cued yet', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })
})

describe('PlayerBar toggles', () => {
  it('persists shuffle and repeat to settings while the Library is the queue', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    // The styling of an enabled toggle keys off `aria-pressed`, so the flip is the anchor for it.
    expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Shuffle' }))
    expect(api.settings.set).toHaveBeenCalledWith({ libraryShuffle: true })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Shuffle' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )

    await user.click(screen.getByRole('button', { name: 'Repeat' }))
    expect(api.settings.set).toHaveBeenCalledWith({ libraryRepeat: true })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Repeat' })).toHaveAttribute('aria-pressed', 'true')
    )
  })

  it('persists shuffle and repeat to the playlist while a playlist is the queue', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b'])] })
    await renderApp()

    // Viewing the playlist is not enough — playing something in it is what makes it the queue.
    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))

    await user.click(screen.getByRole('button', { name: 'Shuffle' }))
    expect(api.playlists.setPlaybackOptions).toHaveBeenCalledWith('p1', { shuffle: true })

    await user.click(screen.getByRole('button', { name: 'Repeat' }))
    expect(api.playlists.setPlaybackOptions).toHaveBeenCalledWith('p1', { repeat: true })
    expect(api.settings.set).not.toHaveBeenCalled()
  })
})

describe('PlayerBar sliders', () => {
  it('tracks playback position and seeks the audio element', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()
    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))

    const audio = audioElement()
    stubDuration(audio, 30)
    fireEvent.durationChange(audio)
    audio.currentTime = 10
    fireEvent.timeUpdate(audio)

    const seek = screen.getByRole('slider', { name: 'Seek' })
    expect(seek).toHaveValue('10')

    fireEvent.change(seek, { target: { value: '20' } })
    expect(audio.currentTime).toBe(20)
  })

  it('persists the volume once, after the slider settles', async () => {
    const api = seedApi({ songs })
    await renderApp()

    const volume = screen.getByRole('slider', { name: 'Volume' })
    fireEvent.change(volume, { target: { value: '0.8' } })
    fireEvent.change(volume, { target: { value: '0.5' } })
    fireEvent.change(volume, { target: { value: '0.3' } })

    expect(audioElement().volume).toBe(0.3)
    await waitFor(() => expect(api.settings.set).toHaveBeenCalledTimes(1))
    expect(api.settings.set).toHaveBeenCalledWith({ volume: 0.3 })
  })
})
