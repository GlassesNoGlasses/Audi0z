import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import { appRoot, renderApp, seedApi, songTitles, stubMediaElement } from '../testing/harness'

stubMediaElement()

const URL_UNDER_TEST = 'https://example.com/watch?v=abc'

async function openAddDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Add song' }))
}

describe('AddSongDialog — file source', () => {
  it('pre-fills the title from the file name, defaults compression from settings and adds', async () => {
    const user = userEvent.setup()
    const api = seedApi({ settings: { compressByDefault: true } })
    vi.mocked(api.files.pickAudioFiles).mockResolvedValue(['/music/Great Track.mp3'])
    await renderApp()

    await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: 'Choose files…' }))

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Great Track')
    )
    expect(screen.getByRole('checkbox', { name: 'Compress to Opus' })).toBeChecked()

    await user.type(screen.getByRole('textbox', { name: 'Tags (comma separated)' }), ' slowed , ,')
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
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42')
    expect(screen.getByText('Downloading… 42%')).toBeInTheDocument()
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
