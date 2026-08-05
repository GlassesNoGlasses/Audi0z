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
  sortView,
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
  const { playback, dialog, sort } = useAppState()
  return (
    <div>
      <span data-testid="playing">{playback.currentId ?? 'nothing'}</span>
      <span data-testid="queue">{playback.order.join(' ')}</span>
      <span data-testid="isPlaying">{playback.isPlaying ? 'playing' : 'paused'}</span>
      <span data-testid="playToken">{playback.playToken}</span>
      <span data-testid="dialog">{dialog === null ? 'none' : JSON.stringify(dialog)}</span>
      <span data-testid="sort">{sort === null ? 'manual' : `${sort.field} ${sort.direction}`}</span>
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

function bar(seed: Seed, rng?: Rng): ReactElement {
  return (
    <AppProvider>
      <Seeder seed={seed}>
        <TopNav rng={rng} />
        <Probe />
      </Seeder>
    </AppProvider>
  )
}

async function renderTopNav(seed: Seed = {}, rng?: Rng): Promise<RenderResult> {
  let result: RenderResult | undefined
  await act(async () => {
    result = render(bar(seed, rng))
  })
  if (!result) throw new Error('renderTopNav: render produced nothing')
  return result
}

/**
 * Moves the mounted bar to another view. A fresh `seed` object re-runs the Seeder's effect, and
 * none of what it re-dispatches touches `playback` — so whatever is playing goes on playing.
 */
async function reseed(result: RenderResult, seed: Seed, rng?: Rng): Promise<void> {
  await act(async () => {
    result.rerender(bar(seed, rng))
  })
}

function probe(name: 'playing' | 'queue' | 'isPlaying' | 'playToken' | 'dialog' | 'sort'): string {
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

  /**
   * The play token is the assertion that matters: `useAudioElement` reloads the source whenever it
   * moves, so an unchanged token is what proves the pause did not rewind the song.
   */
  it('pauses the view it is already playing instead of restarting it', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Play Library' }))
    const token = probe('playToken')
    await user.click(screen.getByRole('button', { name: 'Pause Library' }))

    expect(probe('isPlaying')).toBe('paused')
    expect(probe('playing')).toBe('a')
    expect(probe('playToken')).toBe(token)
  })

  it('resumes a paused view from where it stopped', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(screen.getByRole('button', { name: 'Play Library' }))
    const token = probe('playToken')
    await user.click(screen.getByRole('button', { name: 'Pause Library' }))
    await user.click(screen.getByRole('button', { name: 'Play Library' }))

    expect(probe('isPlaying')).toBe('playing')
    expect(probe('playing')).toBe('a')
    expect(probe('playToken')).toBe(token)
  })

  it('still hands the queue over when a different view is playing', async () => {
    const user = userEvent.setup()
    const result = await renderTopNav({ songs, playlists: [mixes] })

    await user.click(screen.getByRole('button', { name: 'Play Library' }))
    await reseed(result, { songs, playlists: [mixes], view: { kind: 'playlist', id: 'p1' } })
    await user.click(screen.getByRole('button', { name: 'Play Mixes' }))

    expect(probe('queue')).toBe('c a')
    expect(probe('playing')).toBe('c')
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

describe('TopNav sort menu', () => {
  function trigger(): HTMLElement {
    return screen.getByRole('button', { name: 'Sort songs' })
  }

  it('opens and shuts the menu from its own button', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger())

    expect(screen.getByRole('menu', { name: 'Sort songs' })).toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')

    await user.click(trigger())

    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  /** Oldest first, then newest first: the second press on the mode in force is the flip. */
  it('sorts by date added ascending, and flips direction on the next press', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /^Date added/)
    expect(probe('sort')).toBe('addedAt asc')

    await sortView(user, /^Date added/)
    expect(probe('sort')).toBe('addedAt desc')
  })

  /** A different field is a fresh question, so it is asked ascending rather than inheriting. */
  it('starts a new field ascending rather than carrying the last direction over', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /^Date added/, 2)
    expect(probe('sort')).toBe('addedAt desc')

    await sortView(user, /^Duration/)
    expect(probe('sort')).toBe('durationSec asc')
  })

  it('goes back to the stored order from Manual order', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /^Duration/)
    await sortView(user, 'Manual order')

    expect(probe('sort')).toBe('manual')
  })

  it('ticks the mode in force and shuts behind the choice', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })
    await user.click(trigger())

    const items = (): HTMLElement[] => screen.getAllByRole('menuitemradio')
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false'
    ])

    await user.click(screen.getByRole('menuitemradio', { name: /^Duration/ }))
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger())
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true'
    ])
  })

  it('shuts on Escape, handing focus back to the button that opened it', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(trigger())
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(probe('sort')).toBe('manual')
  })

  it('shuts on a click outside itself', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(trigger())
    await user.click(screen.getByTestId('sort'))

    expect(screen.queryByRole('menu')).toBeNull()
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
