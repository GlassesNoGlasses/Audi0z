import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * electron-builder finds the app icon by convention (buildResources/icon.icns), so nothing fails
 * at build time when it is missing — the dmg silently ships Electron's stock icon. This is the
 * guard that keeps the asset in the repo.
 */
describe('packaged app icon', () => {
  it('ships a real icns where electron-builder looks for it', async () => {
    const icns = await readFile(new URL('../../build/icon.icns', import.meta.url))
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(icns.length).toBeGreaterThan(10_000)
  })

  it('ships the square master the other platforms build from', async () => {
    const png = await readFile(new URL('../../build/icon.png', import.meta.url))
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  })
})
