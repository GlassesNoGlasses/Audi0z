import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTmpLibrary } from './tmpLibrary'

describe('createTmpLibrary', () => {
  it('creates an isolated library root with an audio directory, and cleans it up', async () => {
    const lib = await createTmpLibrary()
    try {
      expect(existsSync(lib.root)).toBe(true)
      expect(lib.audio).toBe(path.join(lib.root, 'audio'))
      expect(existsSync(lib.audio)).toBe(true)
    } finally {
      await lib.cleanup()
    }
    expect(existsSync(lib.root)).toBe(false)
  })

  it('hands out a different directory every call', async () => {
    const [a, b] = await Promise.all([createTmpLibrary(), createTmpLibrary()])
    try {
      expect(a.root).not.toBe(b.root)
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()])
    }
  })
})
