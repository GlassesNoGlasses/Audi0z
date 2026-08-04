import { act, render, screen, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Playlist, Settings, SongDto } from '../../../shared/types'
import type { Rng } from '../playback/types'
import { AppProvider, useAppDispatch, useAppState } from '../state/AppContext'
import { FALLBACK_SETTINGS, type Dialog, type View } from '../state/appReducer'
import {
  nowPlaying,
  playlist,
  renderApp,
  seedApi,
  sidebar,
  song,
  stubMediaElement
} from '../testing/harness'
import { TopNav } from './TopNav'

stubMediaElement()

const songs = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
const mixes = playlist('p1', 'Mixes', ['c', 'a'])

/**
 * The shuffled start is picked by an injected rng, which the App never passes — so these tests
 * mount the bar on its own over a real store, with a probe reporting the two things its buttons
 * move: what is playing, and which dialog was asked for.
 */

interface Seed {
  songs?: SongDto[]
  playlists?: Playlist[]
  view?: View
  settings?: Partial<Settings>
}

function Probe(): ReactElement {
  const { playback, dialog } = useAppState()
  return (
    <div>
      <span data-testid="playing">{playback.currentId ?? 'nothing'}</span>
      <span data-testid="queue">{playback.order.join(' ')}</span>
      <span data-testid="dialog">{dialog === null ? 'none' : JSON.stringify(dialog)}</span>
    </div>
  )
}

function Seeder({ seed, children }: { seed: Seed; children: ReactNode }): ReactElement | null {
  const [ready, setReady] = useState(false)
  const dispatch = useAppDispatch()

  useEffect(() => {
    dispatch({ type: 'settings/updated', settings: { ...FALLBACK_SETTINGS, ...seed.settings } })
    dispatch({ type: 'library/loaded', songs: seed.songs ?? [] })
    dispatch({ type: 'playlists/loaded', playlists: seed.playlists ?? [] })
    dispatch({ type: 'view/selected', view: seed.view ?? { kind: 'library' } })
    setReady(true)
  }, [dispatch, seed])

  return ready ? <>{children}</> : null
}

async function renderTopNav(seed: Seed = {}, rng?: Rng): Promise<RenderResult> {
  let result: RenderResult | undefined
  await act(async () => {
    result = render(
      <AppProvider>
        <Seeder seed={seed}>
          <TopNav rng={rng} />
          <Probe />
        </Seeder>
      </AppProvider>
    )
  })
  if (!result) throw new Error('renderTopNav: render produced nothing')
  return result
}

function probe(name: 'playing' | 'queue' | 'dialog'): string {
  return screen.getByTestId(name).textContent ?? ''
}

function openedDialog(): Dialog | null {
  return JSON.parse(probe('dialog') === 'none' ? 'null' : probe('dialog')) as Dialog | null
}

describe('TopNav play button', () => {
  it('starts the view at its first song and queues the whole of it', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Play Library' }))

    expect(probe('playing')).toBe('a')
    expect(probe('queue')).toBe('a b c')
  })

  it('starts a shuffled view wherever the rng points', async () => {
    const user = userEvent.setup()
    const rng = vi.fn<Rng>(() => 1)
    await renderTopNav({ songs, settings: { libraryShuffle: true } }, rng)

    await user.click(screen.getByRole('button', { name: 'Play Library' }))

    expect(rng).toHaveBeenCalledWith(3)
    expect(probe('playing')).toBe('b')
  })

  it("queues the viewed playlist in the playlist's own order", async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs, playlists: [mixes], view: { kind: 'playlist', id: 'p1' } })

    await user.click(screen.getByRole('button', { name: 'Play Mixes' }))

    expect(probe('queue')).toBe('c a')
    expect(probe('playing')).toBe('c')
  })

  it('has nothing to play in an empty view', async () => {
    await renderTopNav()
    expect(screen.getByRole('button', { name: 'Play Library' })).toBeDisabled()
  })
})

describe('TopNav buttons', () => {
  it('asks for the add dialog, still under the name it always had', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Add song' }))

    expect(openedDialog()).toEqual({ kind: 'add', source: { kind: 'files', paths: [] } })
  })

  it('opens the tags dialog', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Tags' }))

    expect(openedDialog()).toEqual({ kind: 'tags' })
  })

  it('opens settings', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(openedDialog()).toEqual({ kind: 'settings' })
  })

  it('offers to add songs to the playlist being viewed', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs, playlists: [mixes], view: { kind: 'playlist', id: 'p1' } })

    await user.click(screen.getByRole('button', { name: 'Add songs to Mixes' }))

    expect(openedDialog()).toEqual({ kind: 'addToPlaylist', playlistId: 'p1' })
  })

  it('offers it nowhere else — the Library is not a playlist', async () => {
    await renderTopNav({ songs })
    expect(screen.queryByRole('button', { name: /Add songs to/ })).toBeNull()
  })
})

describe('TopNav in the app', () => {
  it('plays the library from the top bar', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Play Library' }))

    expect(nowPlaying()).toBe('Alpha Mix')
  })

  it('plays the playlist the sidebar moved to, not the library', async () => {
    const user = userEvent.setup()
    seedApi({ songs, playlists: [mixes] })
    await renderApp()

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    await user.click(screen.getByRole('button', { name: 'Play Mixes' }))

    expect(nowPlaying()).toBe('Charlie Tune')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(nowPlaying()).toBe('Alpha Mix')
  })

  it('opens the add dialog from the download icon', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Add song' }))

    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
  })
})
