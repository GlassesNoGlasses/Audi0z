import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import type { CompressResult } from '../../../shared/types'
import { nowPlaying, renderApp, seedApi, song, stubMediaElement } from '../testing/harness'

stubMediaElement()

const MB = 1024 * 1024

/** The dialog, to scope by: its Delete buttons share their names with the song rows behind it. */
function settings(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Settings' })
}

function fileTitles(): string[] {
  return [...settings().querySelectorAll('.file-title')].map((el) => el.textContent ?? '')
}

async function openSettings(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await renderApp()
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  return user
}

describe('SettingsDialog', () => {
  it('persists the compress-by-default preference', async () => {
    const user = userEvent.setup()
    const api = seedApi({ settings: { compressByDefault: false } })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(
      screen.getByRole('checkbox', { name: 'Compress new audios option by default' })
    )

    expect(api.settings.set).toHaveBeenCalledWith({ compressByDefault: true })
    expect(
      await screen.findByRole('checkbox', { name: 'Compress new audios option by default' })
    ).toBeChecked()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    seedApi()
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  /** Everything here persists the moment it is used, so the footer has nothing to submit. */
  it('closes from the ok button', async () => {
    seedApi()
    const user = await openSettings()

    const footer = settings().querySelector('.dialog-actions')
    expect([...(footer?.querySelectorAll('button') ?? [])].map((el) => el.textContent)).toEqual([
      'Ok'
    ])
    expect(within(settings()).queryByRole('button', { name: 'Update yt-dlp' })).toBeNull()

    await user.click(within(settings()).getByRole('button', { name: 'Ok' }))

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('says what compressing saves, in bold, next to the preference', async () => {
    seedApi()
    await openSettings()

    const estimate = screen.getByText('Saves ~25%')
    expect(estimate.tagName).toBe('STRONG')
    expect(
      screen.getByRole('checkbox', { name: 'Compress new audios option by default' })
    ).toBeVisible()
  })
})

describe('SettingsDialog storage', () => {
  it('adds up what the library weighs and opens the folder holding it', async () => {
    const api = seedApi({
      songs: [
        song('a', 'Alpha Mix', { sizeBytes: 4 * MB }),
        song('b', 'Bravo Beat', { sizeBytes: 2 * MB }),
        // Gone from disk: it weighs nothing here rather than breaking the sum.
        song('c', 'Charlie Tune', { exists: false, sizeBytes: null })
      ]
    })
    const user = await openSettings()

    expect(settings()).toHaveTextContent('Storage: 6.0 MB')

    await user.click(within(settings()).getByRole('button', { name: 'Show' }))
    expect(api.library.showFolder).toHaveBeenCalled()
  })

  it('says so when the folder cannot be opened', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    vi.mocked(api.library.showFolder).mockRejectedValue(new Error('no such directory'))
    const user = await openSettings()

    await user.click(within(settings()).getByRole('button', { name: 'Show' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('no such directory')
  })

  it('lists the files heaviest first, with the unmeasurable ones last', async () => {
    seedApi({
      songs: [
        song('a', 'Alpha Mix', { sizeBytes: 1 * MB }),
        song('b', 'Bravo Beat', { exists: false, sizeBytes: null }),
        song('c', 'Charlie Tune', { sizeBytes: 4 * MB })
      ]
    })
    const user = await openSettings()

    const disclosure = within(settings()).getByRole('button', { name: 'Audio files' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(fileTitles()).toEqual([])

    await user.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(fileTitles()).toEqual(['Charlie Tune', 'Alpha Mix', 'Bravo Beat'])
    expect(settings()).toHaveTextContent('4.0 MB')
    // Nothing to show for the file that is gone.
    expect(settings()).toHaveTextContent('—')
  })

  it('quotes a real saving when it can, and the generic one when it cannot', async () => {
    seedApi({
      songs: [
        song('a', 'Alpha Mix', { sizeBytes: 5 * MB, durationSec: 120 }),
        song('b', 'Bravo Beat', { sizeBytes: 5 * MB })
      ]
    })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    const measured = screen.getByText('~3.6 MB save')
    expect(measured.tagName).toBe('STRONG')
    // One next to the preference, one on the row with no duration to reckon with.
    expect(screen.getAllByText('Saves ~25%')).toHaveLength(2)
  })

  it('compresses a file, and says what it now weighs', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix', { sizeBytes: 4 * MB })] })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    expect(api.library.compress).toHaveBeenCalledWith('a')
    expect(await screen.findByRole('alert')).toHaveTextContent('Compressed "Alpha Mix"')
    await waitFor(() => expect(settings()).toHaveTextContent('3.0 MB'))
    // Nothing left to compress on that row.
    expect(within(settings()).queryByRole('button', { name: 'Compress Alpha Mix' })).toBeNull()
  })

  /** A re-encode that came out no smaller resolves like one that worked — only `shrank` differs. */
  it('says it kept the original when the re-encode would not have been smaller', async () => {
    const unchanged = song('a', 'Alpha Mix', { sizeBytes: 4 * MB })
    const api = seedApi({ songs: [unchanged] })
    vi.mocked(api.library.compress).mockResolvedValue({ song: unchanged, shrank: false })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Alpha Mix" is already smaller than an Opus re-encode — kept the original'
    )
    // Nothing changed on disk or in the row, so the offer is still there to take again.
    expect(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })).toBeEnabled()
    expect(settings()).toHaveTextContent('4.0 MB')
  })

  /** ffmpeg is expensive and the row is one click wide: a second run must not be startable. */
  it('takes no second click while a file is being compressed', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix', { sizeBytes: 4 * MB })] })
    const compressed = song('a', 'Alpha Mix', { compressed: true, sizeBytes: 1 * MB })
    let finish = (_result: CompressResult): void => {}
    vi.mocked(api.library.compress).mockReturnValue(
      new Promise<CompressResult>((resolve) => {
        finish = resolve
      })
    )
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    expect(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })).toBeDisabled()

    await act(async () => {
      // The settle re-reads the library, so the stubbed store has to be moved on too.
      mockApiControls(api).state.songs = [compressed]
      finish({ song: compressed, shrank: true })
    })

    expect(api.library.compress).toHaveBeenCalledTimes(1)
    expect(within(settings()).queryByRole('button', { name: 'Compress Alpha Mix' })).toBeNull()
  })

  /** ffmpeg replaces the file in place, which breaks the `<audio>` element's next Range request. */
  it('does not offer to compress the song the player is holding', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    const held = within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })
    expect(held).toBeDisabled()
    expect(held).toHaveAccessibleDescription(/currently playing/i)
    expect(within(settings()).getByRole('button', { name: 'Compress Bravo Beat' })).toBeEnabled()
  })

  it('says out loud why the playing song cannot be compressed', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    const held = within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })
    expect(held).toBeDisabled()
    // A `title` computes an accessible description too, so pin its absence.
    expect(held).not.toHaveAttribute('title')
    expect(held).toHaveAccessibleDescription('Cannot compress file currently playing.')
    expect(within(settings()).getByText('Cannot compress file currently playing.')).toBeVisible()
    // The reason takes the savings quote's slot, leaving the preference's and the free row's.
    expect(screen.getAllByText('Saves ~25%')).toHaveLength(2)
  })

  it('offers it again once the player has moved on', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(screen.getByRole('button', { name: 'Bravo Beat' }))
    expect(nowPlaying()).toBe('Bravo Beat')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    expect(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })).toBeEnabled()
    expect(within(settings()).getByRole('button', { name: 'Compress Bravo Beat' })).toBeDisabled()
  })

  it('says so when a file cannot be compressed', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    vi.mocked(api.library.compress).mockRejectedValue(
      new Error('Song "Alpha Mix" is already compressed')
    )
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already compressed')
    expect(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' })).toBeEnabled()
  })

  /** `exists` is derived on the main process's side only, so a raced dto sticks until a re-read. */
  it('re-reads the library after a compression settles', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix', { sizeBytes: 4 * MB })] })
    // Main never emits `libraryChanged`, so the dialog's own re-read is all that can heal a row.
    vi.mocked(api.library.compress).mockResolvedValue({
      song: song('a', 'Alpha Mix', { compressed: true, sizeBytes: 3 * MB }),
      shrank: true
    })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))
    // The boot load listed the library once already; only what the click causes is under test.
    vi.mocked(api.library.list).mockClear()

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    await waitFor(() => expect(api.library.list).toHaveBeenCalled())
  })

  /** A failure is exactly when a row may be stale, so the re-read hangs off `finally`, not `then`. */
  it('re-reads the library even when the compression fails', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix', { sizeBytes: 4 * MB })] })
    vi.mocked(api.library.compress).mockRejectedValue(new Error('ffmpeg exited with code 1'))
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))
    vi.mocked(api.library.list).mockClear()

    await user.click(within(settings()).getByRole('button', { name: 'Compress Alpha Mix' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('ffmpeg exited with code 1')
    await waitFor(() => expect(api.library.list).toHaveBeenCalled())
  })

  it('offers nothing to compress on a file that already is', async () => {
    seedApi({ songs: [song('a', 'Alpha Mix', { compressed: true })] })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    expect(within(settings()).queryByRole('button', { name: 'Compress Alpha Mix' })).toBeNull()
    expect(fileTitles()).toEqual(['Alpha Mix'])
  })

  /** ffmpeg needs a file to read, so the offer could only spend a click on a failure toast. */
  it('does not offer to compress a file that is not there', async () => {
    seedApi({ songs: [song('b', 'Bravo Beat', { exists: false, sizeBytes: null })] })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    expect(within(settings()).queryByRole('button', { name: 'Compress Bravo Beat' })).toBeNull()
    // Only the offer goes: the row still says which file it is, what it weighs, and can be deleted.
    expect(fileTitles()).toEqual(['Bravo Beat'])
    expect(settings().querySelector('.file-size')?.textContent).toBe('—')
    expect(within(settings()).getByRole('button', { name: 'Delete Bravo Beat' })).toBeEnabled()
  })

  it('moves a file to the trash once, and only once, it is confirmed', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Delete Alpha Mix' }))
    expect(within(settings()).getByText('Move Alpha Mix to the trash?')).toBeInTheDocument()

    await user.click(within(settings()).getByRole('button', { name: 'Cancel' }))
    expect(api.library.remove).not.toHaveBeenCalled()

    await user.click(within(settings()).getByRole('button', { name: 'Delete Alpha Mix' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete' }))

    expect(api.library.remove).toHaveBeenCalledWith('a')
    await waitFor(() => expect(fileTitles()).toEqual(['Bravo Beat']))
  })

  /** The same failure has to tell the same story here as it does from the song row's own menu. */
  it('says the song survived a delete the OS refused, exactly as the row does', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    vi.mocked(api.library.remove).mockRejectedValue(new Error('Failed to move item a.wav to trash'))
    const user = await openSettings()
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))

    await user.click(within(settings()).getByRole('button', { name: 'Delete Alpha Mix' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to move item a.wav to trash — the song is still in your library.'
    )
    expect(fileTitles()).toEqual(['Alpha Mix'])
  })

  /** Re-reading the library reshapes only the queue's ORDER; the history is the engine's own. */
  it('takes the deleted song out of the transport, not just out of the list', async () => {
    const user = userEvent.setup()
    seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    await user.click(screen.getByRole('button', { name: 'Bravo Beat' }))
    expect(nowPlaying()).toBe('Bravo Beat')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete Alpha Mix' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(fileTitles()).toEqual(['Bravo Beat']))
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Previous' }))

    // Nothing behind it in the history, so Prev restarts rather than cueing a song that is gone.
    expect(nowPlaying()).toBe('Bravo Beat')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  /** The scrub rides the delete's `.then()`: a delete the OS refused must stop nothing. */
  it('leaves the transport untouched when the OS refuses the delete', async () => {
    const user = userEvent.setup()
    const api = seedApi({ songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat')] })
    vi.mocked(api.library.remove).mockRejectedValue(new Error('Failed to move item a.wav to trash'))
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Alpha Mix' }))
    expect(nowPlaying()).toBe('Alpha Mix')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(within(settings()).getByRole('button', { name: 'Audio files' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete Alpha Mix' }))
    await user.click(within(settings()).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('still in your library')
    expect(fileTitles()).toEqual(['Alpha Mix', 'Bravo Beat'])
    expect(nowPlaying()).toBe('Alpha Mix')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })
})
