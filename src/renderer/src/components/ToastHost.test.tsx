import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * A toast that never leaves is a toast the user ends up ignoring — and the stack is capped, so
 * yesterday's failure eventually hides today's. Ten seconds is long enough to read a line of
 * ffmpeg stderr and short enough that the corner clears itself.
 */
describe('ToastHost expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes a toast down once it has had its ten seconds', async () => {
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'trash', message: 'Failed to move item to trash' })
    })

    act(() => {
      vi.advanceTimersByTime(9_900)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('gives a toast pushed later its own clock', async () => {
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'trash', message: 'First failure' })
    })
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    act(() => {
      controls.emitError({ source: 'ytdlp', message: 'Second failure' })
    })

    // The first one's ten seconds are up; the second one still has six of its own left.
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    const remaining = screen.getAllByRole('alert')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toHaveTextContent('Second failure')

    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('still dismisses on click, well before the timer gets there', async () => {
    const api = seedApi()
    const controls = mockApiControls(api)
    await renderApp()

    act(() => {
      controls.emitError({ source: 'import', message: 'Failed to import' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // And the timer it left behind has nothing to do when it fires.
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
