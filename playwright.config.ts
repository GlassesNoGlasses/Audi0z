import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the built Electron binary (`_electron.launch`), not a browser — so there
 * are deliberately no browser projects here and `npx playwright install` is never needed.
 *
 * The suite runs single-worker: every test owns the same on-disk library (isolated per test via
 * `AUDI0Z_LIBRARY_DIR`) and a single app instance.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env['CI']),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results'
})
