import { defineConfig } from 'vitest/config'

/**
 * Two projects, because this repo has two runtimes:
 *   node  — main process, shared contracts and the test-support helpers
 *   jsdom — renderer (React) code, with a mock `window.api` installed by the setup file
 *
 * Vitest 4 dropped `vitest.workspace.ts`; `test.projects` is the replacement. `globals` stays off
 * on purpose — every test imports what it uses from `vitest`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'tests/support/**/*.test.ts'
          ]
        }
      },
      {
        esbuild: {
          jsx: 'automatic',
          jsxImportSource: 'react'
        },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/support/setupJsdom.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/renderer/src/main.tsx', 'src/**/*.d.ts']
    }
  }
})
