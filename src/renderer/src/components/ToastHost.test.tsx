import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApiControls } from '../../../../tests/support/mockApi'
import { renderApp, seedApi, stubMediaElement } from '../testing/harness'

stubMediaElement()

describe('ToastHost', () => {
  it('shows errors pushed from the main process, stacks them and dismisses them', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'trash', message: 'Failed to move item to trash' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to move item to trash')

    // The shape `withErrorReport` really forwards: yt-dlp's own `ERROR:` line is part of the
    // stderr tail, below the summary, never the start of the message.
    act(() => {
      controls.emitError({
        source: 'ytdlp',
        message: 'yt-dlp download failed (exit 1):\nERROR: Unsupported URL'
      })
    })
    expect(screen.getAllByRole('alert')).toHaveLength(2)

    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    const remaining = screen.getAllByRole('alert')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toHaveTextContent('ERROR: Unsupported URL')
  })

  /**
   * The push channel used to render `error.message` raw while every renderer call site rendered
   * `errorMessage(error)`. Two normalisations meant two different strings for one failure, which
   * is both uglier and unmatchable by the duplicate collapse.
   */
  it('normalises a main-process message the way a rejected invoke is normalised', async () => {
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'ytdlp', message: 'YtDlpError: nothing to download  ' })
    })

    const toast = screen.getByRole('alert')
    expect(toast).toHaveTextContent('nothing to download')
    expect(toast.textContent).not.toContain('YtDlpError')
  })

  it('has something to say even when the main process reports an empty message', async () => {
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'import', message: '' })
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
  })
})
