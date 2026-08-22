import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppError } from '../shared/types'
import {
  createWindowSender,
  fileExists,
  fileSize,
  resolveResourcesBinDir,
  runStartup,
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

/** `library:list` runs one of these per song inside a `Promise.all`: it must never reject. */
describe('fileSize', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mml-wiring-size-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the byte count of a file that is there', async () => {
    const present = path.join(dir, 'here.txt')
    await writeFile(present, 'twelve bytes')

    await expect(fileSize(present)).resolves.toBe(12)
  })

  /** Zero is a real size, and must not read as "missing" anywhere downstream. */
  it('reports 0 for an empty file rather than null', async () => {
    const empty = path.join(dir, 'empty.opus')
    await writeFile(empty, '')

    await expect(fileSize(empty)).resolves.toBe(0)
  })

  it('answers null for a path that is not there', async () => {
    await expect(fileSize(path.join(dir, 'gone.txt'))).resolves.toBeNull()
  })

  it('answers null rather than rejecting for an unreadable path', async () => {
    // A path under a file is not a path at all (ENOTDIR).
    await writeFile(path.join(dir, 'a-file'), 'x')

    await expect(fileSize(path.join(dir, 'a-file', 'nested'))).resolves.toBeNull()
    await expect(fileSize('')).resolves.toBeNull()
  })

  /** `stat` succeeds on a directory and reports the inode size, hence the `isFile()` check. */
  it('answers null for a directory, which has a stat size but is not a file', async () => {
    await expect(fileSize(dir)).resolves.toBeNull()
  })
})

describe('resolveResourcesBinDir', () => {
  it('reads out of the app bundle once packaged', () => {
    expect(
      resolveResourcesBinDir({
        isPackaged: true,
        resourcesPath: '/Applications/mml.app/Contents/Resources',
        mainDir: '/Applications/mml.app/Contents/Resources/app.asar/out/main',
        platform: 'darwin'
      })
    ).toBe(path.join('/Applications/mml.app/Contents/Resources', 'bin'))
  })

  /** Derived from the bundle's own location, not `app.getAppPath()`, which follows the entry. */
  it('reads the per-platform checkout directory, however electron was launched', () => {
    expect(
      resolveResourcesBinDir({
        isPackaged: false,
        resourcesPath: '/ignored',
        mainDir: path.join('/repo', 'out', 'main'),
        platform: 'win32'
      })
    ).toBe(path.join('/repo', 'resources', 'bin', 'win32'))
  })

  it('agrees with where package.json says the main bundle is built', async () => {
    const repoRoot = process.cwd()
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8')
    ) as Record<string, string>
    const mainDir = path.dirname(path.resolve(repoRoot, manifest.main))

    expect(
      resolveResourcesBinDir({
        isPackaged: false,
        resourcesPath: '/ignored',
        mainDir,
        platform: 'darwin'
      })
    ).toBe(path.join(repoRoot, 'resources', 'bin', 'darwin'))
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

describe('runStartup', () => {
  function fakeShell() {
    return { showErrorBox: vi.fn<(title: string, content: string) => void>(), quit: vi.fn() }
  }

  it('stays out of the way when startup succeeds', async () => {
    const shell = fakeShell()
    const startup = vi.fn()

    await runStartup(startup, shell)

    expect(startup).toHaveBeenCalledTimes(1)
    expect(shell.showErrorBox).not.toHaveBeenCalled()
    expect(shell.quit).not.toHaveBeenCalled()
  })

  /** Anything failing before the first window otherwise surfaces as an unhandled rejection. */
  it('shows what went wrong and quits when startup throws', async () => {
    const shell = fakeShell()

    await runStartup(() => {
      throw new Error('EACCES: permission denied, mkdir /read-only/audi0z')
    }, shell)

    expect(shell.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('start'),
      expect.stringContaining('EACCES: permission denied')
    )
    expect(shell.quit).toHaveBeenCalledTimes(1)
  })

  it('catches an async failure too', async () => {
    const shell = fakeShell()

    await runStartup(async () => {
      await Promise.resolve()
      throw new Error('library.json is a directory')
    }, shell)

    expect(shell.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('library.json is a directory')
    )
    expect(shell.quit).toHaveBeenCalledTimes(1)
  })

  it('still says something when what was thrown is not an Error', async () => {
    const shell = fakeShell()

    await runStartup(() => {
      throw 'just a string'
    }, shell)

    expect(shell.showErrorBox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('just a string')
    )
    expect(shell.quit).toHaveBeenCalledTimes(1)
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
