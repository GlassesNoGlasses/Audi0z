import { spawn } from 'node:child_process'

/**
 * The single seam between this app and the outside world's binaries.
 *
 * **This is the only module in the repo allowed to import `node:child_process`.** Everything else
 * (ffmpeg, yt-dlp) takes a `RunLines` function as a dependency, which is what lets the whole
 * ingest pipeline be unit-tested without a single external process.
 */

export interface RunLinesOptions {
  /** Absolute path to the binary. Never a shell string — args are passed as an array. */
  bin: string
  args: string[]
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  /** Aborting kills the child and rejects the promise with an `AbortError`. */
  signal?: AbortSignal
  /**
   * How long an aborted child gets to exit on SIGTERM before it is sent SIGKILL. Defaults to
   * `KILL_GRACE_MS`; production has no reason to change it, and the escalation test would
   * otherwise have to sit through the real wait.
   */
  killGraceMs?: number
}

export interface RunLinesResult {
  /** The child's exit code (`-1` when it died without one). Callers decide what nonzero means. */
  code: number
  /** The last `STDERR_TAIL_LINES` stderr lines — enough context for an error message. */
  stderrTail: string[]
}

export type RunLines = (opts: RunLinesOptions) => Promise<RunLinesResult>

export const STDERR_TAIL_LINES = 20

/**
 * How long a cancelled process group has to honour SIGTERM before SIGKILL settles it.
 *
 * Without the escalation a child that ignores SIGTERM never fires `close`, so this promise never
 * settles — and `downloader`'s `finally` never clears `running`, leaving every later download
 * rejecting with BUSY for the life of the main process, with nothing in the UI able to clear it.
 */
export const KILL_GRACE_MS = 5000

/** The slice of a `ChildProcess` {@link killProcessTree} needs — which is what makes it unit-testable. */
export interface KillableChild {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Signals a child *and everything it spawned*.
 *
 * `child.kill()` signals exactly one pid, so yt-dlp's ffmpeg — a grandchild — survives a cancel and
 * keeps burning CPU and writing into a temp directory the downloader has already deleted. Because
 * the spawn below is `detached` on POSIX, the child leads a process group of its own; signalling
 * the *negative* pid delivers to every member of that group, ffmpeg included.
 *
 * Windows keeps today's exact single-process behaviour: there `detached` means "outlive the
 * parent", not "new process group", and negative pids aren't a thing. The app doesn't ship there.
 *
 * The `try` is load-bearing, not defensive garnish. `process.kill` throws ESRCH once the group is
 * gone — the ordinary race where the child exited on its own between `exit` and `close` — and this
 * runs inside an abort listener, where a throw surfaces as an `uncaughtException` that kills the
 * main process rather than as a rejected download.
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): void {
  const { pid } = child
  if (pid !== undefined && platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The group is gone (ESRCH) or not ours to signal (EPERM). Fall through to the direct kill,
      // which is a no-op on a child that has already exited.
    }
  }
  child.kill(signal)
}

function abortError(bin: string): Error {
  const error = new Error(`aborted: ${bin}`)
  error.name = 'AbortError'
  return error
}

/**
 * Turns arbitrary chunks into whole lines.
 *
 * Splits on LF, CRLF *and* lone CR — ffmpeg and yt-dlp both use bare carriage returns for their
 * progress redraws, and treating those as line breaks keeps a single "line" from growing without
 * bound. Empty segments are dropped, so a CRLF straddling two chunks cannot produce a blank line.
 */
function lineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const parts = buffer.split(/\r\n|\n|\r/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part !== '') onLine(part)
      }
    },
    flush() {
      const last = buffer
      buffer = ''
      if (last !== '') onLine(last)
    }
  }
}

export const runLines: RunLines = ({
  bin,
  args,
  onStdout,
  onStderr,
  signal,
  killGraceMs = KILL_GRACE_MS
}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(bin))
      return
    }

    const stderrTail: string[] = []
    const stdout = lineSplitter((line) => onStdout?.(line))
    const stderr = lineSplitter((line) => {
      stderrTail.push(line)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      onStderr?.(line)
    })

    // stdin is ignored on purpose: a child that waits on input would otherwise hang forever.
    // `detached` on POSIX buys a process *group*, not a detached process — it is what makes the
    // group kill in `killProcessTree` reach yt-dlp's ffmpeg. Deliberately no `child.unref()`: the
    // promise settles on `close`, which needs the child still attached and its pipes still ours.
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))

    // Armed on abort, cleared the moment the child settles. `unref` as well as `clearTimeout`:
    // neither this timer nor a missed clear may be what keeps the process alive.
    let killTimer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      killProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      finish()
    }

    child.on('error', (error) => settle(() => reject(error)))

    // `close` rather than `exit`: it fires once the stdio streams are drained, so no output is lost.
    child.on('close', (code) =>
      settle(() => {
        stdout.flush()
        stderr.flush()
        if (signal?.aborted) {
          reject(abortError(bin))
          return
        }
        resolve({ code: code ?? -1, stderrTail })
      })
    )
  })
