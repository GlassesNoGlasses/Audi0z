import { describe, expect, it } from 'vitest'
// @ts-expect-error -- untyped CommonJS build hook: no .d.ts, and allowJs is off in tsconfig.node.
import { desktopCopies } from '../../build/copyArtifactsToDesktop.js'

/**
 * Covers the selection half of the electron-builder afterAllArtifactBuild hook at
 * build/copyArtifactsToDesktop.js.
 *
 * It sits under tests/support because vitest.config.ts's node project globs only `src/main`,
 * `src/shared` and `tests/support` — nothing reaches build/.
 *
 * Only `desktopCopies` is exercised: it is pure, so what gets copied where is pinned without a
 * filesystem, and the default export is left as the thin `copyFile` loop around it.
 */

describe('desktop artifact delivery', () => {
  it('copies installers and skips blockmaps and directories', () => {
    expect(
      desktopCopies(
        ['/d/app-0.1.0-arm64.dmg', '/d/app-0.1.0-arm64.dmg.blockmap', '/d/builder-debug.yml'],
        '/Users/x/Desktop'
      )
    ).toEqual([{ from: '/d/app-0.1.0-arm64.dmg', to: '/Users/x/Desktop/app-0.1.0-arm64.dmg' }])
  })

  it('has nothing to do for a --dir build', () => {
    expect(desktopCopies(undefined, '/Users/x/Desktop')).toEqual([])
  })
})
