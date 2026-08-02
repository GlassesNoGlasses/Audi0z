import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppError } from '../shared/types'
import {
  createWindowSender,
  fileExists,
  resolveResourcesBinDir,
  withErrorReport,
  type RendererTarget
} from './wiring'

describe('fileExists', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mml-wiring-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('answers for a file that is there and one that is not', async () => {
    const present = path.join(dir, 'here.txt')
    await writeFile(present, 'x')
    await expect(fileExists(present)).resolves.toBe(true)
    await expect(fileExists(path.join(dir, 'gone.txt'))).resolves.toBe(false)
  })
})

describe('resolveResourcesBinDir', () => {
  it('reads out of the app bundle once packaged', () => {
    expect(
      resolveResourcesBinDir({
        isPackaged: true,
        resourcesPath: '/Applications/mml.app/Contents/Resources',
        appPath: '/Applications/mml.app/Contents/Resources/app.asar',
        platform: 'darwin'
      })
    ).toBe(path.join('/Applications/mml.app/Contents/Resources', 'bin'))
  })

  it('reads the per-platform checkout directory in development', () => {
    expect(
      resolveResourcesBinDir({
        isPackaged: false,
        resourcesPath: '/ignored',
        appPath: '/repo',
        platform: 'win32'
      })
    ).toBe(path.join('/repo', 'resources', 'bin', 'win32'))
  })
})

describe('createWindowSender', () => {
  function fakeWindow(): {
    window: RendererTarget
    send: ReturnType<typeof vi.fn>
    destroy(): void
    destroyContents(): void
  } {
    const send = vi.fn()
    let destroyed = false
    let contentsDestroyed = false
    return {
      window: {
        isDestroyed: () => destroyed,
        webContents: { isDestroyed: () => contentsDestroyed, send }
      },
      send,
      destroy: () => {
        destroyed = true
      },
      destroyContents: () => {
        contentsDestroyed = true
      }
    }
  }

  it('resolves the window on every call, so it works for a window created later', () => {
    let target: ReturnType<typeof fakeWindow> | null = null
    const sendTo = createWindowSender(() => target?.window ?? null)

    sendTo('event:x', { a: 1 })

    target = fakeWindow()
    sendTo('event:x', { a: 2 })
    expect(target.send).toHaveBeenCalledExactlyOnceWith('event:x', { a: 2 })
  })

  it('stays quiet once the window or its contents are gone', () => {
    const target = fakeWindow()
    const sendTo = createWindowSender(() => target.window)

    target.destroy()
    sendTo('event:x', 1)
    expect(target.send).not.toHaveBeenCalled()

    const other = fakeWindow()
    const sendToOther = createWindowSender(() => other.window)
    other.destroyContents()
    sendToOther('event:x', 1)
    expect(other.send).not.toHaveBeenCalled()
  })

  it('never throws, whatever the send does', () => {
    const target = fakeWindow()
    target.send.mockImplementation(() => {
      throw new Error('window went away mid-send')
    })
    const sendTo = createWindowSender(() => target.window)
    expect(() => sendTo('event:x', 1)).not.toThrow()
  })
})

describe('withErrorReport', () => {
  it('passes the result straight through', async () => {
    const report = vi.fn()
    const wrapped = withErrorReport('import', report, async (n: number) => n * 2)
    await expect(wrapped(21)).resolves.toBe(42)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports the failure and still rejects with the original error', async () => {
    const report = vi.fn<(error: AppError) => void>()
    const boom = new Error('disk on fire')
    const wrapped = withErrorReport('trash', report, async () => {
      throw boom
    })

    await expect(wrapped()).rejects.toBe(boom)
    expect(report).toHaveBeenCalledWith({ source: 'trash', message: 'disk on fire' })
  })

  it('says nothing about a cancellation the user asked for', async () => {
    const report = vi.fn()
    const cancelled = new Error('download cancelled')
    cancelled.name = 'Cancelled'
    const wrapped = withErrorReport('ytdlp', report, async () => {
      throw cancelled
    })

    await expect(wrapped()).rejects.toBe(cancelled)
    expect(report).not.toHaveBeenCalled()
  })
})
