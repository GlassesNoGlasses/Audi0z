import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  nowPlaying,
  playlist,
  renderApp,
  seedApi,
  sidebar,
  song,
  songTitles,
  stubMediaElement
} from '../testing/harness'

stubMediaElement()

const MB = 1024 * 1024

const songs = [song('a', 'Alpha Mix', { tags: ['slowed'] }), song('b', 'Bravo Beat')]

const registry = [
  { id: 't1', name: 'slowed', color: '#e0a35c' },
  { id: 't2', name: 'reverb', color: '#3b2f8f' }
]

/** The row's overflow menu, opened from the ⋯ button. */
async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  title: string
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `Options for ${title}` }))
  return screen.getByRole('menu')
}

describe('SongRow', () => {
  it('plays the song that was clicked', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Bravo Beat' }))

    expect(nowPlaying()).toBe('Bravo Beat')
    expect(screen.getByRole('button', { name: 'Bravo Beat' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('anchors the row with the playing time on the left and the size on the right', async () => {
    seedApi({
      songs: [
        song('a', 'Alpha Mix', { durationSec: 173, sizeBytes: 4 * MB }),
        // Nothing has measured this one yet, and its file is gone: both anchors say so.
        song('b', 'Bravo Beat', { exists: false, sizeBytes: null })
      ]
    })
    await renderApp()

    const [alpha, bravo] = [...document.querySelectorAll<HTMLElement>('.song-row')]
    expect(within(alpha).getByText('2:53')).toHaveClass('song-duration')
    expect(within(alpha).getByText('4.0 MB')).toHaveClass('song-size')
    expect(within(bravo).getByText('–:––')).toHaveClass('song-duration')
    expect(within(bravo).getByText('—')).toHaveClass('song-size')
  })

  it('dates the row between the tags and the size', async () => {
    // The stamp is built from local-time parts, so the day it reads back as — and therefore the
    // literal below — is the same in every timezone the suite might run in.
    const addedAt = new Date(2024, 0, 15, 12, 30).toISOString()
    seedApi({ songs: [song('a', 'Alpha Mix', { addedAt, tags: ['slowed'], sizeBytes: 4 * MB })] })
    await renderApp()

    const [alpha] = [...document.querySelectorAll<HTMLElement>('.song-row')]
    const added = within(alpha).getByText('01/15/2024')
    expect(added).toHaveClass('song-added')
    // Placement, which formatDate's own tests cannot see: after the tags, before the size.
    const tag = within(alpha).getByText('slowed')
    const size = within(alpha).getByText('4.0 MB')
    expect(tag.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(added.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('paints a tag in the registry colour, and one the registry has never heard of in grey', async () => {
    seedApi({
      songs: [song('a', 'Alpha Mix', { tags: ['slowed', 'bootleg'] })],
      tags: registry
    })
    await renderApp()

    expect(screen.getByText('slowed')).toHaveStyle({
      backgroundColor: '#e0a35c',
      color: '#000000'
    })
    // No registry entry, so no colour of its own — the stylesheet's grey stands.
    expect(screen.getByText('bootleg')).not.toHaveAttribute('style')
  })

  it('offers the row itself nothing but the title and the menu', async () => {
    seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a'])] })
    await renderApp()

    expect(screen.queryByRole('combobox', { name: /playlist/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reveal Alpha Mix' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Alpha Mix' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete Alpha Mix' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Options for Alpha Mix' })).toHaveAttribute(
      'aria-haspopup',
      'menu'
    )
  })
})

describe('SongRow menu', () => {
  it('opens on the ⋯ button and closes again on Escape', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await openMenu(user, 'Alpha Mix')
    expect(screen.getByRole('button', { name: 'Options for Alpha Mix' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes when the click lands outside it', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await openMenu(user, 'Alpha Mix')
    await user.click(document.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the edit dialog from the menu, and closes the menu behind it', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }))

    expect(screen.getByRole('dialog', { name: 'Edit song' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha Mix')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('deletes a song only after confirmation, and clears it out of playback', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByRole('dialog', { name: 'Confirm' })).toHaveTextContent(
      'Move Alpha Mix to the trash?'
    )
    expect(api.library.remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(api.library.remove).toHaveBeenCalledWith('a')
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat']))
    // `library/songsRemoved` reached the playback engine, not just the list.
    expect(nowPlaying()).toBe('Nothing playing')
  })

  it('closes the confirmation on Escape without deleting anything', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull()
    expect(api.library.remove).not.toHaveBeenCalled()
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
  })

  it('takes a song out of the playlist it is being viewed in, keeping it in the library', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, playlists: [playlist('p1', 'Mixes', ['a', 'b'])] })
    await renderApp()

    // Only offered inside a playlist: in the Library there is nothing to remove it from.
    const libraryMenu = await openMenu(user, 'Alpha Mix')
    expect(within(libraryMenu).queryByRole('menuitem', { name: /Remove from/ })).toBeNull()
    await user.keyboard('{Escape}')

    await user.click(within(sidebar()).getByRole('button', { name: 'Mixes' }))
    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove from "Mixes"' }))

    expect(api.playlists.removeSong).toHaveBeenCalledWith('p1', 'a')
    await waitFor(() => expect(songTitles()).toEqual(['Bravo Beat']))
    expect(api.library.remove).not.toHaveBeenCalled()

    await user.click(within(sidebar()).getByRole('button', { name: 'Library' }))
    expect(songTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
  })

  /** A screen reader hears one menu per row; only the song's name tells them which row it belongs to. */
  it('names the menu after its song', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Options for Alpha Mix' }))

    expect(screen.getByRole('menu', { name: 'Options for Alpha Mix' })).toBeInTheDocument()
  })

  it('walks its items with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    const items = within(menu).getAllByRole('menuitem')

    expect(items[0]).toHaveFocus() // focus lands on open
    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(items[items.length - 1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(items[0]).toHaveFocus() // wraps
    await user.keyboard('{ArrowUp}')
    expect(items[items.length - 1]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
  })

  it('hands focus back to the ⋯ button when Escape closes the menu', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await openMenu(user, 'Alpha Mix')
    await user.keyboard('{Escape}')

    expect(screen.getByRole('button', { name: 'Options for Alpha Mix' })).toHaveFocus()
  })

  /** An outside click has already chosen where the user is going; stealing focus back would undo it. */
  it('leaves focus alone when a click outside closes the menu', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    await openMenu(user, 'Alpha Mix')
    await user.click(screen.getByRole('button', { name: 'Bravo Beat' }))

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Options for Alpha Mix' })).not.toHaveFocus()
  })

  /**
   * jsdom has no layout, so the flip decision is driven by stubbed rects: a popup whose natural
   * position overflows the list's bottom, with room above, must get the --up modifier.
   */
  it('flips upward when its natural position would clip into the bottom of the list', async () => {
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('song-menu-popup')) {
        return DOMRect.fromRect({ y: 560, height: 160 })
      }
      if (this.classList.contains('song-menu')) {
        return DOMRect.fromRect({ y: 540, width: 28, height: 20 })
      }
      if (this.classList.contains('song-list')) return DOMRect.fromRect({ y: 0, height: 600 })
      return DOMRect.fromRect({})
    })
    try {
      const user = userEvent.setup()
      seedApi({ songs })
      await renderApp()

      const menu = await openMenu(user, 'Alpha Mix')

      expect(menu).toHaveClass('song-menu-popup--up')
    } finally {
      rects.mockRestore()
    }
  })

  /**
   * The other half of the flip condition, which the test above cannot reach: down overflows here
   * too, but a popup taller than the whole list has no room above it either. Flipping would only
   * move the clipping to the top, so it stays down — an implementation joining the two halves with
   * `||` instead of `&&` flips and fails this.
   */
  it('stays down when it is too tall to fit above the list either', async () => {
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('song-menu-popup')) {
        return DOMRect.fromRect({ y: 560, height: 700 })
      }
      if (this.classList.contains('song-menu')) {
        return DOMRect.fromRect({ y: 540, width: 28, height: 20 })
      }
      if (this.classList.contains('song-list')) return DOMRect.fromRect({ y: 0, height: 600 })
      return DOMRect.fromRect({})
    })
    try {
      const user = userEvent.setup()
      seedApi({ songs })
      await renderApp()

      const menu = await openMenu(user, 'Alpha Mix')

      expect(menu).not.toHaveClass('song-menu-popup--up')
    } finally {
      rects.mockRestore()
    }
  })

  /** The default all-zero jsdom rects are the "there is room below" case: no modifier, no flip. */
  it('stays put when there is room below it', async () => {
    const user = userEvent.setup()
    seedApi({ songs })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')

    expect(menu).not.toHaveClass('song-menu-popup--up')
  })
})

describe('SongRow tag menu', () => {
  it('puts a registry tag on the song and takes it off again', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, tags: registry })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Tags' }))

    // What the song already carries is ticked; the rest of the registry is offered alongside it.
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'slowed' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'reverb' })).toHaveAttribute(
      'aria-checked',
      'false'
    )

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'reverb' }))

    expect(api.library.update).toHaveBeenCalledWith('a', { tags: ['slowed', 'reverb'] })
    await waitFor(() =>
      expect(screen.getByRole('menuitemcheckbox', { name: 'reverb' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
    )

    await user.click(screen.getByRole('menuitemcheckbox', { name: 'slowed' }))

    expect(api.library.update).toHaveBeenLastCalledWith('a', { tags: ['reverb'] })
    await waitFor(() =>
      expect(screen.getByRole('menuitemcheckbox', { name: 'slowed' })).toHaveAttribute(
        'aria-checked',
        'false'
      )
    )
  })

  it('sends the user to the Tags dialog when the registry is empty', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs })
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Tags' }))

    expect(
      within(menu).getByRole('menuitem', { name: 'No tags yet — create them from Tags.' })
    ).toBeDisabled()
    expect(api.library.update).not.toHaveBeenCalled()
  })

  it('says so when the tag cannot be saved', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs, tags: registry })
    vi.mocked(api.library.update).mockRejectedValue(new Error('library.json is read-only'))
    await renderApp()

    const menu = await openMenu(user, 'Alpha Mix')
    await user.click(within(menu).getByRole('menuitem', { name: 'Tags' }))
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'reverb' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('library.json is read-only')
  })
})
