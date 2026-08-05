import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import { appRoot, renderApp, seedApi, songTitles, stubMediaElement } from '../testing/harness'

stubMediaElement()

const URL_UNDER_TEST = 'https://example.com/watch?v=abc'

const MB = 1024 * 1024

const registry = [
  { id: 't1', name: 'slowed', color: '#e0a35c' },
  { id: 't2', name: 'reverb', color: '#3b2f8f' }
]

async function openAddDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Add song' }))
}

/** The one bar the dialog draws while a download runs. */
function progressTrack(): HTMLElement {
  return screen.getByRole('progressbar', { name: 'Download progress' })
}

function progressFill(): HTMLElement {
  const fill = progressTrack().querySelector<HTMLElement>('.progress-fill')
  if (!fill) throw new Error('the progress bar rendered no fill')
  return fill
}

describe('AddSongDialog — file source', () => {
  it('pre-fills the title from the file name, defaults compression from settings and adds', async () => {
    const user = userEvent.setup()
    const api = seedApi({ settings: { compressByDefault: true }, tags: registry })
    vi.mocked(api.files.pickAudioFiles).mockResolvedValue(['/music/Great Track.mp3'])
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'Choose files…' }))

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Great Track')
    )
    expect(screen.getByRole('checkbox', { name: 'Compress to Opus' })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'slowed' }))
    await user.click(screen.getByRole('button', { name: 'Add to library' }))

    expect(api.library.add).toHaveBeenCalledWith({
      sourcePath: '/music/Great Track.mp3',
      title: 'Great Track',
      tags: ['slowed'],
      compress: true
    })
    await waitFor(() => expect(songTitles()).toEqual(['Great Track']))
  })

  it('opens pre-filled from a drop, resolving every dropped file through the preload', async () => {
    const api = seedApi()
    await renderApp()

    const files = [
      new File(['x'], 'One Track.mp3', { type: 'audio/mpeg' }),
      new File(['y'], 'Two Track.wav', { type: 'audio/wav' })
    ]
    await act(async () => {
      fireEvent.drop(appRoot(), { dataTransfer: { files, types: ['Files'] } })
    })

    // `File.path` no longer exists in Electron — every path comes from the preload helper.
    expect(api.files.getPathForFile).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('One Track')
  })
})

describe('AddSongDialog — tags', () => {
  it('carries the chips that were picked, in the order the registry lists them', async () => {
    const user = userEvent.setup()
    const api = seedApi({ tags: registry })
    vi.mocked(api.files.pickAudioFiles).mockResolvedValue(['/music/Great Track.mp3'])
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Great Track')
    )

    // Picked out of order, and one of them picked twice — a chip is a toggle.
    await user.click(screen.getByRole('button', { name: 'reverb' }))
    await user.click(screen.getByRole('button', { name: 'slowed' }))
    expect(screen.getByRole('button', { name: 'reverb' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'reverb' }))
    expect(screen.getByRole('button', { name: 'reverb' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Add to library' }))

    expect(api.library.add).toHaveBeenCalledWith(expect.objectContaining({ tags: ['slowed'] }))
  })

  /** Tags are created in one place only. Offering to make one here is what made them a mess. */
  it('sends the user to the Tags button when the registry is empty', async () => {
    const user = userEvent.setup()
    seedApi()
    await renderApp()

    await openAddDialog(user)

    expect(screen.getByText('No tags yet — create them from the Tags button.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Tags/ })).toBeNull()
  })

  it('says what compressing saves, in bold, beside the checkbox', async () => {
    const user = userEvent.setup()
    seedApi()
    await renderApp()

    await openAddDialog(user)

    expect(screen.getByText('Saves ~25%').tagName).toBe('STRONG')
    // The preference itself is still addressable by exactly the words on it.
    expect(screen.getByRole('checkbox', { name: 'Compress to Opus' })).toBeInTheDocument()
  })
})

describe('AddSongDialog — url source', () => {
  it('probes for the title, then downloads and tracks progress', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    const controls = mockApiControls(api)
    vi.mocked(api.download.start).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))

    expect(api.download.probe).toHaveBeenCalledWith(URL_UNDER_TEST)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
        `Mock title for ${URL_UNDER_TEST}`
      )
    )

    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(api.download.start).toHaveBeenCalledWith({
      url: URL_UNDER_TEST,
      title: `Mock title for ${URL_UNDER_TEST}`,
      tags: [],
      compress: false
    })

    act(() => {
      controls.emitDownloadProgress({ stage: 'downloading', percent: 42 })
    })
    expect(progressTrack()).toHaveAttribute('aria-valuenow', '42')
    expect(progressFill()).toHaveStyle({ width: '42%' })
    expect(screen.getByText('Downloading… 42%')).toBeInTheDocument()

    act(() => {
      controls.emitDownloadProgress({ stage: 'downloading', percent: 71 })
    })
    expect(progressFill()).toHaveStyle({ width: '71%' })
  })

  it('shows how far along in bytes when the download says', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    const controls = mockApiControls(api)
    vi.mocked(api.download.start).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Some Remix')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    act(() => {
      controls.emitDownloadProgress({ stage: 'downloading', percent: 40, bytes: 4 * MB })
    })
    // Half a figure is no figure: without a total there is nothing to be 4 MB of.
    expect(screen.queryByText(/4\.0 MB \//)).toBeNull()

    act(() => {
      controls.emitDownloadProgress({
        stage: 'downloading',
        percent: 40,
        bytes: 4 * MB,
        totalBytes: 10 * MB
      })
    })
    expect(screen.getByText('4.0 MB / 10.0 MB')).toBeInTheDocument()
  })

  /** Saving and transcoding cannot report a percentage; the bar has to say "working" anyway. */
  it('slides the bar when the stage has no percentage to report', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    const controls = mockApiControls(api)
    vi.mocked(api.download.start).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Some Remix')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    act(() => {
      controls.emitDownloadProgress({ stage: 'saving', percent: null })
    })

    expect(progressFill()).toHaveClass('progress-indeterminate')
    expect(progressTrack()).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText('Saving…')).toBeInTheDocument()
  })

  /**
   * The bundled yt-dlp is a self-extracting binary: its first run after launch spends half a minute
   * unpacking itself. Saying so is the difference between a slow probe and a hung dialog.
   */
  it('warns that the first probe after launch is slow, while it is running', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.download.probe).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    expect(
      screen.queryByText('Fetching details… (the first fetch after launch can take ~30s)')
    ).toBeNull()

    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))

    const hint = screen.getByText('Fetching details… (the first fetch after launch can take ~30s)')
    expect(hint.querySelector('.spinner')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fetch details' })).toBeDisabled()
  })

  it('stops warning once the probe answers', async () => {
    const user = userEvent.setup()
    seedApi()
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))

    await waitFor(() =>
      expect(
        screen.queryByText('Fetching details… (the first fetch after launch can take ~30s)')
      ).toBeNull()
    )
  })

  /**
   * A probe has no cancel path of its own — `download.cancel()` only reaches a running download —
   * so swapping the close button out for "Cancel download" while one is in flight left a hung
   * probe with no way out of the dialog at all.
   */
  it('still offers a way out while a probe is in flight', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.download.probe).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))

    expect(screen.queryByRole('button', { name: 'Cancel download' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Add song' })).toBeNull()
    expect(api.download.cancel).not.toHaveBeenCalled()
  })

  it('closes on Escape while a probe is in flight', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.download.probe).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Add song' })).toBeNull()
  })

  /**
   * Matching the button it stands in for: a running download is cancelled rather than orphaned,
   * and the dialog stays up so the user can see what happened and try again.
   */
  it('cancels the download rather than closing when Escape lands mid-download', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.download.start).mockImplementation(() => new Promise(() => undefined))
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Some Remix')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(screen.getByRole('button', { name: 'Cancel download' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(api.download.cancel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
  })

  it('keeps the dialog open and shows the failure when the download rejects', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.download.start).mockRejectedValue(
      new Error(
        "Error invoking remote method 'download:start': YtDlpError: ERROR: Unsupported URL: " +
          URL_UNDER_TEST
      )
    )
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))
    await user.type(screen.getByRole('textbox', { name: 'URL' }), URL_UNDER_TEST)
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).not.toHaveValue(''))
    await user.click(screen.getByRole('button', { name: 'Download' }))

    const toast = await screen.findByRole('alert')
    expect(toast).toHaveTextContent('Unsupported URL')
    expect(screen.getByRole('dialog', { name: 'Add song' })).toBeInTheDocument()
  })
})

describe('AddSongDialog — what it accepts', () => {
  /**
   * The list mirrors the picker filter in main/index.ts, and it has to survive a pick: the other
   * files-mode hint turns into the chosen path, so the list cannot live inside it.
   */
  it('lists the audio types the file picker accepts', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    vi.mocked(api.files.pickAudioFiles).mockResolvedValue(['/music/Great Track.mp3'])
    await renderApp()

    await openAddDialog(user)
    expect(screen.getByText(/MP3, M4A, AAC, FLAC, WAV, OGG, Opus, AIFF, WMA/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Choose files…' }))
    await waitFor(() => expect(screen.getByText('/music/Great Track.mp3')).toBeInTheDocument())
    expect(screen.getByText(/MP3, M4A, AAC, FLAC, WAV, OGG, Opus, AIFF, WMA/)).toBeInTheDocument()
  })

  /** yt-dlp decides what a URL may be, and a playlist link is the one that surprises people. */
  it('says what urls can come from', async () => {
    const user = userEvent.setup()
    seedApi()
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'From URL' }))

    const hint = screen.getByText(/Downloads use yt-dlp/)
    expect(hint).toHaveTextContent('A playlist link fetches only the linked item')
    // Standing hint, not the probing one: it is here before any fetch and says nothing about waiting.
    expect(
      screen.queryByText('Fetching details… (the first fetch after launch can take ~30s)')
    ).toBeNull()
  })
})
