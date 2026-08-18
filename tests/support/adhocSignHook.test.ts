import childProcess from 'node:child_process'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Covers the electron-builder afterPack hook at build/adhocSign.js.
 *
 * It sits under tests/support because vitest.config.ts's node project globs only `src/main`,
 * `src/shared` and `tests/support` — nothing reaches build/, and the vitest config is not widened
 * for a single build hook.
 *
 * `vi.mock('node:child_process')` does not work here: the hook is CommonJS and its `require` of a
 * builtin resolves natively, past vitest's mock registry. Spying on the builtin's (mutable) exports
 * object does work, as long as the spy is installed before the hook is imported and destructures
 * `execFileSync` — hence the dynamic import in `beforeAll`.
 */

const execFileSync = vi
  .spyOn(childProcess, 'execFileSync')
  .mockImplementation(() => Buffer.alloc(0))

type PackContext = {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

let adhocSign: (context: PackContext) => Promise<void>

beforeAll(async () => {
  // @ts-expect-error -- untyped CommonJS build hook: no .d.ts, and allowJs is off in tsconfig.node.
  const loaded = await import('../../build/adhocSign.js')
  // CJS-to-ESM interop hands back either the function or the whole `module.exports`.
  const exported = loaded.default as { default?: unknown }
  adhocSign = (exported.default ?? exported) as (context: PackContext) => Promise<void>
})

const context = (electronPlatformName: string): PackContext => ({
  electronPlatformName,
  appOutDir: '/tmp/dist/mac-arm64',
  packager: { appInfo: { productFilename: 'audi0z' } }
})

describe('adhocSign afterPack hook', () => {
  afterEach(() => {
    execFileSync.mockClear()
  })

  it('ad-hoc signs the packed .app on darwin', async () => {
    await adhocSign(context('darwin'))

    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync).toHaveBeenCalledWith(
      'codesign',
      ['--force', '--deep', '--sign', '-', '/tmp/dist/mac-arm64/audi0z.app'],
      { stdio: 'inherit' }
    )
  })

  it('signs the bundle named after the product, not the output directory', async () => {
    await adhocSign({
      electronPlatformName: 'darwin',
      appOutDir: '/tmp/dist/mac-universal',
      packager: { appInfo: { productFilename: 'My Music Library' } }
    })

    expect(execFileSync.mock.calls[0][1]).toContain('/tmp/dist/mac-universal/My Music Library.app')
  })

  it('does nothing on win32', async () => {
    await adhocSign(context('win32'))

    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('does nothing on linux', async () => {
    await adhocSign(context('linux'))

    expect(execFileSync).not.toHaveBeenCalled()
  })
})
