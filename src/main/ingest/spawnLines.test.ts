import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree, processError, runLines, type KillableChild } from './spawnLines'

/**
 * A child whose stdio this file drives by hand — the only way to stage output arriving *after* the
 * run has settled, which no real child can do (its streams are closed by then). `vi.hoisted`
 * because `vi.mock` is lifted above the imports; a null `fake` leaves the real `spawn` in place, so
 * every other test in this file still runs an actual process.
 */
interface FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: EventEmitter & { setEncoding(encoding: string): void }
  stderr: EventEmitter & { setEncoding(encoding: string): void }
  kill(signal?: NodeJS.Signals): boolean
}

const spawnState = vi.hoisted(() => ({ fake: null as FakeChild | null }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>): unknown =>
    spawnState.fake ?? actual.spawn(...args)
  return { ...actual, spawn }
})

function fakeChildProcess(): FakeChild {
  const stream = (): FakeChild['stdout'] =>
    Object.assign(new EventEmitter(), { setEncoding: () => {} })
  return Object.assign(new EventEmitter(), {
    // No pid on purpose: a fake pid would route `killProcessTree` at a real process group.
    pid: undefined,
    stdout: stream(),
    stderr: stream(),
    kill: () => true
  })
}

/**
 * The only place in the repo that spawns a real child process — and the child is always `node`
 * itself (`process.execPath`), never an external binary, so these tests need nothing installed.
 */
const NODE = process.execPath

/**
 * Process groups and negative-pid signals are POSIX concepts; on Windows `runLines` deliberately
 * keeps its old single-process kill, so the tests that assert group behaviour simply don't apply.
 */
const POSIX = process.platform !== 'win32'

/**
 * Resolves with the first stdout line the child writes — how these tests learn a pid only the child
 * knows (its own, or the one it just spawned). Later lines are ignored: a promise settles once.
 */
function firstLine(): { onStdout: (line: string) => void; line: Promise<string> } {
  let emit: (line: string) => void = () => {}
  const line = new Promise<string>((resolve) => {
    emit = resolve
  })
  return { onStdout: (value) => emit(value), line }
}

/**
 * Polls until `pid` is unsignallable, i.e. really gone. Signal `0` performs the permission and
 * existence checks without delivering anything. Returns `false` on timeout so a failing assertion
 * reads as "still alive" rather than as a hung test.
 */
async function awaitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** Never lets a failing run leak a live process into the rest of the suite. */
function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone — which is the outcome these tests are asserting anyway.
  }
}

describe('runLines', () => {
  afterEach(() => {
    spawnState.fake = null
  })

  it('re-assembles a line split across chunks and flushes the final unterminated line', async () => {
    const lines: string[] = []
    const result = await runLines({
      bin: NODE,
      args: [
        '-e',
        `process.stdout.write('par'); setTimeout(() => process.stdout.write('tial\\nlast line without newline'), 25)`
      ],
      onStdout: (line) => lines.push(line)
    })

    expect(result.code).toBe(0)
    expect(lines).toEqual(['partial', 'last line without newline'])
  })

  it('splits on CRLF and never emits empty lines', async () => {
    const lines: string[] = []
    await runLines({
      bin: NODE,
      args: ['-e', `process.stdout.write('a\\r\\n\\r\\nb\\r\\n')`],
      onStdout: (line) => lines.push(line)
    })

    expect(lines).toEqual(['a', 'b'])
  })

  it('keeps only the last 20 stderr lines in stderrTail', async () => {
    const result = await runLines({
      bin: NODE,
      args: ['-e', `for (let i = 1; i <= 50; i++) process.stderr.write('err ' + i + '\\n')`]
    })

    expect(result.stderrTail).toHaveLength(20)
    expect(result.stderrTail[0]).toBe('err 31')
    expect(result.stderrTail.at(-1)).toBe('err 50')
  })

  it('resolves — rather than rejects — on a nonzero exit code', async () => {
    const onStderr = vi.fn()
    const result = await runLines({
      bin: NODE,
      args: ['-e', `process.stderr.write('boom\\n'); process.exit(3)`],
      onStderr
    })

    expect(result.code).toBe(3)
    expect(result.stderrTail).toEqual(['boom'])
    expect(onStderr).toHaveBeenCalledWith('boom')
  })

  /**
   * Both settle paths owe the caller the same two things, and the failing path is the one that
   * used to skip them: the buffered partial line is lost, and a chunk arriving after the rejection
   * still reaches `onStdout` — a PROGRESS line landing on a renderer that already reset.
   */
  it('flushes the buffered partials and stops listening the moment it settles', async () => {
    const child = fakeChildProcess()
    spawnState.fake = child
    const stdoutLines: string[] = []
    const stderrLines: string[] = []

    const promise = runLines({
      bin: NODE,
      args: [],
      onStdout: (line) => stdoutLines.push(line),
      onStderr: (line) => stderrLines.push(line)
    })

    child.stdout.emit('data', 'first\nunterminated')
    child.stderr.emit('data', 'ERROR: no newline either')
    child.emit('error', new Error('spawn EACCES'))

    await expect(promise).rejects.toThrow(/EACCES/)

    child.stdout.emit('data', 'too late\n')
    child.stderr.emit('data', 'too late as well\n')

    expect(stdoutLines).toEqual(['first', 'unterminated'])
    expect(stderrLines).toEqual(['ERROR: no newline either'])
  })

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      runLines({ bin: path.join(os.tmpdir(), 'mml-no-such-binary-xyz'), args: [] })
    ).rejects.toThrow(/ENOENT/)
  })

  /**
   * yt-dlp's JS-runtime child needs ELECTRON_RUN_AS_NODE, and the caller names only that. Anything
   * it does *not* name has to survive: the bundled PyInstaller binary unpacks itself into TMPDIR,
   * and a win32 spawn without SystemRoot fails outright — so overrides merge, never replace.
   */
  it('merges the overrides over the inherited environment', async () => {
    const lines: string[] = []
    const result = await runLines({
      bin: NODE,
      args: [
        '-e',
        `process.stdout.write(process.env.MML_ENV_MARKER + '|' + String((process.env.PATH ?? '').length > 0))`
      ],
      onStdout: (line) => lines.push(line),
      envOverrides: { MML_ENV_MARKER: 'passed-through' }
    })

    expect(result.code).toBe(0)
    expect(lines).toEqual(['passed-through|true'])
  })

  it('kills the child and rejects when the signal aborts', async () => {
    const controller = new AbortController()
    const promise = runLines({
      bin: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 25)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  /**
   * The whole point of the escalation: a child that swallows SIGTERM would otherwise never fire
   * `close`, this promise would never settle, and the downloader's `running` slot would stay
   * occupied — every later start rejecting with BUSY for the life of the main process.
   */
  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const controller = new AbortController()
    let markReady = (): void => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })

    const promise = runLines({
      bin: NODE,
      args: [
        '-e',
        `process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
      ],
      signal: controller.signal,
      killGraceMs: 50,
      onStdout: (line) => {
        if (line === 'ready') markReady()
      }
    })

    await ready
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('clears the grace timer as soon as the child settles', async () => {
    // Only the two clocks `runLines` itself uses are faked — faking `setImmediate` as well would
    // stall the child's stdio streams, which this test needs to be real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const controller = new AbortController()
      let markReady = (): void => {}
      const ready = new Promise<void>((resolve) => {
        markReady = resolve
      })

      const promise = runLines({
        bin: NODE,
        args: ['-e', `process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`],
        signal: controller.signal,
        killGraceMs: 60_000,
        onStdout: (line) => {
          if (line === 'ready') markReady()
        }
      })

      await ready
      expect(vi.getTimerCount()).toBe(0)

      controller.abort()
      expect(vi.getTimerCount()).toBe(1)

      // A live 60s timer left behind would keep the whole process alive long after the child.
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects without spawning anything when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const onStdout = vi.fn()

    await expect(
      runLines({
        bin: NODE,
        args: ['-e', `process.stdout.write('should never run\\n')`],
        signal: controller.signal,
        onStdout
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onStdout).not.toHaveBeenCalled()
  })

  it.skipIf(!POSIX)('spawns the child as the leader of a process group of its own', async () => {
    const controller = new AbortController()
    const { onStdout, line } = firstLine()

    const promise = runLines({
      bin: NODE,
      args: ['-e', `process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000)`],
      signal: controller.signal,
      onStdout
    })
    const pid = Number(await line)

    try {
      // A group id equal to the child's pid only exists if the child leads one. Undetached, the
      // child joins this test runner's group and signal 0 against `-pid` throws ESRCH.
      expect(() => process.kill(-pid, 0)).not.toThrow()

      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      forceKill(pid)
    }
  })

  /**
   * The bug this whole change exists for: yt-dlp spawns ffmpeg, so the process that must die on a
   * cancel is a *grandchild*. The stand-in grandchild uses `stdio: 'ignore'` on purpose — it
   * isolates "the grandchild survived" from the separate symptom of an inherited pipe holding
   * `close` open.
   */
  it.skipIf(!POSIX)('kills the grandchild the child spawned, not just the child', async () => {
    const controller = new AbortController()
    const { onStdout, line } = firstLine()
    const script = [
      `const { spawn } = require('node:child_process')`,
      `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })`,
      `process.stdout.write(grandchild.pid + '\\n')`,
      `setInterval(() => {}, 1000)`
    ].join('; ')

    const promise = runLines({
      bin: NODE,
      args: ['-e', script],
      signal: controller.signal,
      onStdout
    })
    const grandchildPid = Number(await line)

    try {
      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      expect(await awaitGone(grandchildPid)).toBe(true)
    } finally {
      forceKill(grandchildPid)
    }
  })

  it.skipIf(!POSIX)(
    'escalates SIGKILL to the whole group when both generations ignore SIGTERM',
    async () => {
      const controller = new AbortController()
      const { onStdout, line } = firstLine()
      const script = [
        `const { spawn } = require('node:child_process')`,
        `process.on('SIGTERM', () => {})`,
        `const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })`,
        `process.stdout.write(grandchild.pid + '\\n')`,
        `setInterval(() => {}, 1000)`
      ].join('; ')

      const promise = runLines({
        bin: NODE,
        args: ['-e', script],
        signal: controller.signal,
        killGraceMs: 50,
        onStdout
      })
      const grandchildPid = Number(await line)

      try {
        controller.abort()
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
        // Nothing but the SIGKILL escalation can settle this one, and only a *group* SIGKILL
        // reaches the generation yt-dlp's ffmpeg stands in for.
        expect(await awaitGone(grandchildPid)).toBe(true)
      } finally {
        forceKill(grandchildPid)
      }
    }
  )

  it.skipIf(!POSIX)('is inert when the signal aborts after the child already exited', async () => {
    // A cancel that lands too late is the production shape of the ESRCH race. `settle` already
    // removed the listener, so nothing is signalled at all; in the narrower exit-to-close gap where
    // the listener is still armed, `killProcessTree`'s catch is what keeps the dead group's ESRCH
    // from escaping this listener as an `uncaughtException` that would take the main process down.
    const controller = new AbortController()

    const result = await runLines({
      bin: NODE,
      args: ['-e', `process.stdout.write('done\\n')`],
      signal: controller.signal
    })

    expect(result.code).toBe(0)
    expect(() => controller.abort()).not.toThrow()
  })
})

/**
 * The renderer never sees the error object — `lib/errors.ts` matches the serialised
 * `<Name>: <message>` text — so both halves are pinned here for the two callers that share them.
 */
describe('processError', () => {
  it('names the error as the caller asked and hangs the stderr tail under the message', () => {
    const error = processError('YtDlpError', 'yt-dlp download failed (exit 1)', [
      'ERROR: unable to download video data',
      'HTTP Error 403'
    ])

    expect(error.name).toBe('YtDlpError')
    expect(error.message).toBe(
      'yt-dlp download failed (exit 1):\nERROR: unable to download video data\nHTTP Error 403'
    )
  })

  it('drops blank tail lines, and the colon along with them when nothing is left', () => {
    const error = processError('FfmpegError', 'ffmpeg exited with code 1', ['  ', ''])

    expect(error.name).toBe('FfmpegError')
    expect(error.message).toBe('ffmpeg exited with code 1')
  })
})

/**
 * Pure unit tests: no process is spawned and `process.kill` is always a spy, so nothing here can
 * signal a real pid. The spy is restored in `afterEach` — the real-process tests above genuinely
 * signal pids, and a `process.kill` stub leaking into them would quietly defeat every assertion.
 */
describe('killProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const fakeChild = (
    pid: number | undefined
  ): KillableChild & { kill: ReturnType<typeof vi.fn> } => ({
    pid,
    kill: vi.fn(() => true)
  })

  it('signals the whole process group rather than the lone child on POSIX', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(4321)

    killProcessTree(child, 'SIGTERM', 'darwin')

    expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('escalates to the whole group too, not just the direct child', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(4321)

    killProcessTree(child, 'SIGKILL', 'darwin')

    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('swallows a dead group and falls back to the direct kill', () => {
    // The real trigger in production: the child exited on its own between `exit` and `close`, so
    // the group is already gone. An exception here escapes the abort listener as an
    // `uncaughtException` and takes the main process down — it must not propagate.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const child = fakeChild(4321)

    expect(() => killProcessTree(child, 'SIGTERM', 'darwin')).not.toThrow()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('keeps the single-process kill on win32, where negative pids mean nothing', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(4321)

    killProcessTree(child, 'SIGTERM', 'win32')

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('skips the group branch entirely when the spawn never produced a pid', () => {
    // `process.kill(-undefined)` is a TypeError, and this runs inside an abort listener.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(undefined)

    expect(() => killProcessTree(child, 'SIGKILL', 'darwin')).not.toThrow()
    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
