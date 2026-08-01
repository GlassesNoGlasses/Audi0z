import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mockApiControls } from '../../../tests/support/mockApi'
import { App } from './App'

/**
 * Smoke test for the jsdom half of the harness: JSX transform, testing-library, the jest-dom
 * matchers and the mock `window.api` installed by the setup file.
 */
describe('App shell', () => {
  it('renders the app name', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('my-music-library')
  })

  it('runs against a mock window.api whose state a test can steer', async () => {
    const controls = mockApiControls(window.api)
    controls.state.settings.volume = 0.5

    await expect(window.api.library.list()).resolves.toEqual([])
    await expect(window.api.settings.get()).resolves.toMatchObject({ volume: 0.5 })
  })

  // Runs after the test above, which left volume at 0.5 — proves the setup file reinstalls a
  // fresh mock for every test rather than sharing one across the file.
  it('gets a fresh mock api, not the one the previous test mutated', async () => {
    await expect(window.api.settings.get()).resolves.toMatchObject({ volume: 1 })
  })
})
