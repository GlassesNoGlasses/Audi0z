import { act, render, screen, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Playlist, Settings, SongDto } from '../../../shared/types'
import { LIBRARY_QUEUE_ID, type Rng } from '../playback/types'
import { AppProvider, useAppDispatch, useAppState } from '../state/AppContext'
import { FALLBACK_SETTINGS, SortDirection, type Dialog, type View } from '../state/appReducer'
import {
  audioElement,
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

/** The shuffled start needs an rng the App never passes, so the bar is mounted on its own. */

interface Seed {
  songs?: SongDto[]
  playlists?: Playlist[]
  view?: View
  settings?: Partial<Settings>
  /** Reproduces App's start-up: the library queue loaded, with nothing chosen to start on. */
  bootQueue?: boolean
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
      <span data-testid="sort">
        {`${sort.type} ${sort.direction === SortDirection.ASC ? 'asc' : 'desc'}`}
      </span>
    </div>
  )
}

function Seeder({ seed, children }: { seed: Seed; children: ReactNode }): ReactElement | null {
  const [ready, setReady] = useState(false)
  const dispatch = useAppDispatch()

  useEffect(() => {
    const settings = { ...FALLBACK_SETTINGS, ...seed.settings }
    dispatch({ type: 'settings/updated', settings })
    dispatch({ type: 'library/loaded', songs: seed.songs ?? [] })
    dispatch({ type: 'playlists/loaded', playlists: seed.playlists ?? [] })
    dispatch({ type: 'view/selected', view: seed.view ?? { kind: 'library' } })
    // What App dispatches at start-up: it omits `startSongId`, so `currentId` stays null.
    if (seed.bootQueue) {
      dispatch({
        type: 'queue/selected',
        queueId: LIBRARY_QUEUE_ID,
        order: (seed.songs ?? []).map((seeded) => seeded.id),
        shuffle: settings.libraryShuffle,
        repeat: settings.libraryRepeat
      })
    }
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

/** Moves the mounted bar to another view; nothing it re-dispatches touches `playback`. */
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

  /** The `currentId !== null` half of `viewIsCued` is what stops a cold start at `order[0]`. */
  it('shuffles out of the boot queue rather than cold-starting at the top', async () => {
    const user = userEvent.setup()
    const rng = vi.fn<Rng>(() => 2)
    await renderTopNav({ songs, settings: { libraryShuffle: true }, bootQueue: true }, rng)
    expect(probe('queue')).toBe('a b c')
    expect(probe('playing')).toBe('nothing')

    await user.click(screen.getByRole('button', { name: 'Play Library' }))

    expect(probe('playing')).toBe('c')
    expect(rng).toHaveBeenCalledWith(3)
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

  /** `useAudioElement` reloads on every play-token move, so an unchanged token proves no rewind. */
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

    await sortView(user, /Date Added$/)
    expect(probe('sort')).toBe('Date Added asc')

    await sortView(user, /Date Added$/)
    expect(probe('sort')).toBe('Date Added desc')
  })

  /** A different field is a fresh question, so it is asked ascending rather than inheriting. */
  it('starts a new field ascending rather than carrying the last direction over', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /Date Added$/, 2)
    expect(probe('sort')).toBe('Date Added desc')

    await sortView(user, /Duration$/)
    expect(probe('sort')).toBe('Duration asc')

    await sortView(user, /Size$/)
    expect(probe('sort')).toBe('Size asc')
  })

  it('sorts by title ascending, and flips direction on the next press', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /Title$/)
    expect(probe('sort')).toBe('Title asc')

    await sortView(user, /Title$/)
    expect(probe('sort')).toBe('Title desc')
  })

  it('goes back to the stored order from Custom Order', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await sortView(user, /Duration$/)
    await sortView(user, 'Custom Order')

    expect(probe('sort')).toBe('Custom Order asc')
  })

  it('ticks the mode in force, shuts, and lifts the choice to the top of the menu', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })
    await user.click(trigger())

    const items = (): HTMLElement[] => screen.getAllByRole('menuitemradio')
    expect(items().map((item) => item.textContent?.trim())).toEqual([
      'Custom Order',
      'Title',
      'Date Added',
      'Duration',
      'Size'
    ])
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false'
    ])

    await user.click(screen.getByRole('menuitemradio', { name: /Duration$/ }))
    expect(screen.queryByRole('menu')).toBeNull()

    // The chosen mode heads the next visit, wearing its direction arrow; the rest keep their order.
    await user.click(trigger())
    expect(items().map((item) => item.textContent?.trim())).toEqual([
      '↓ Duration',
      'Custom Order',
      'Title',
      'Date Added',
      'Size'
    ])
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false'
    ])
  })

  /** The sort in force is named on the bar itself — no need to open the menu to know it. */
  it('names the sort and its direction in force beside the menu button', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })
    expect(screen.getByText('Custom Order')).toBeInTheDocument()

    await sortView(user, /Duration$/)
    expect(screen.getByText('↓ Duration')).toBeInTheDocument()

    await sortView(user, /Duration$/)
    expect(screen.getByText('↑ Duration')).toBeInTheDocument()
    expect(screen.queryByText('Custom Order')).toBeNull()
  })

  it('shuts on Escape, handing focus back to the button that opened it', async () => {
    const user = userEvent.setup()
    await renderTopNav({ songs })

    await user.click(trigger())
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(probe('sort')).toBe('Custom Order asc')
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

  /** The arrow guard rests on the open menu taking focus — provable only over the real app. */
  it('leaves the playing song where it is when an arrow lands on the open sort menu', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    const audio = audioElement()
    audio.currentTime = 15

    await user.click(screen.getByRole('button', { name: 'Sort songs' }))
    await user.keyboard('{ArrowRight}')

    expect(audio.currentTime).toBe(15)
    expect(screen.getByRole('menu', { name: 'Sort songs' })).toBeInTheDocument()
  })

  it('opens the add dialog from the download icon', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Add song' }))

    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
  })
})
