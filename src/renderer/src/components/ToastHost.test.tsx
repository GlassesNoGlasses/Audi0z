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

    act(() => {
      controls.emitError({ source: 'ytdlp', message: 'ERROR: Unsupported URL' })
    })
    expect(screen.getAllByRole('alert')).toHaveLength(2)

    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    const remaining = screen.getAllByRole('alert')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toHaveTextContent('ERROR: Unsupported URL')
  })
})
