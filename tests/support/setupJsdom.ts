import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { createMockApi } from './mockApi'
import type { Api } from '../../src/shared/api'

/**
 * Setup for the `jsdom` vitest project.
 *
 * - registers the jest-dom matchers (`globals` is off, so this import is the only registration)
 * - unmounts anything React left behind (auto-cleanup does not run without vitest globals)
 * - installs a fresh mock `window.api` for every test, so no test inherits another's library state
 */
function installMockApi(): void {
  ;(globalThis as unknown as { api: Api }).api = createMockApi()
}

installMockApi()
beforeEach(installMockApi)
afterEach(cleanup)
