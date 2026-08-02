import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runLines } from './spawnLines'

/**
 * The only place in the repo that spawns a real child process — and the child is always `node`
 * itself (`process.execPath`), never an external binary, so these tests need nothing installed.
 */
const NODE = process.execPath

describe('runLines', () => {
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

  it('rejects when the binary cannot be spawned', async () => {
    await expect(
      runLines({ bin: path.join(os.tmpdir(), 'mml-no-such-binary-xyz'), args: [] })
    ).rejects.toThrow(/ENOENT/)
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
})
