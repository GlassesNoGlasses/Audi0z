import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp, seedApi, stubMediaElement } from '../testing/harness'

stubMediaElement()

describe('SettingsDialog', () => {
  it('persists the compress-by-default preference', async () => {
    const user = userEvent.setup()
    const api = seedApi({ settings: { compressByDefault: false } })
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('checkbox', { name: 'Compress new songs by default' }))

    expect(api.settings.set).toHaveBeenCalledWith({ compressByDefault: true })
    expect(
      await screen.findByRole('checkbox', { name: 'Compress new songs by default' })
    ).toBeChecked()
  })

  it('updates yt-dlp and reports the version it landed on', async () => {
    const user = userEvent.setup()
    const api = seedApi()
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Update yt-dlp' }))

    expect(api.ytdlp.update).toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('yt-dlp updated to 0.0.0-mock')
  })
})
