import { spawn } from 'node:child_process'

/**
 * Runs child processes and pipelines. Every external call must go through here.
 *
 * **This is the only module in the repo allowed to import `node:child_process`.** Everything else
 * (ffmpeg, yt-dlp) takes a `RunLines` function as a dependency.
 */

export interface RunLinesOptions {
  bin: string // binary absolute path
  args: string[]
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  signal?: AbortSignal
  killGraceMs?: number
  env?: NodeJS.ProcessEnv // child env; omitted = inherit this process's
}

export interface RunLinesResult {
  code: number // exite code (-1 if dies)
  stderrTail: string[] // stderr last line for error
}

export type RunLines = (opts: RunLinesOptions) => Promise<RunLinesResult>
export const STDERR_TAIL_LINES = 20

// How long a cancelled process group has to honour SIGTERM before SIGKILL settles it
export const KILL_GRACE_MS = 5000

/** Subset interface of actual node child process interface; used in {@link killProcessTree} */
export interface KillableChild {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Signals a child and every *grandchild* SIGKILL (with grace period).
 * Here because yt-dlp spawns child processes for ffmpeg.
 */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): void {
  const { pid } = child
  if (pid !== undefined && platform !== 'win32') {
    try {
      process.kill(-pid, signal) // POSIX Unix systems
      return
    } catch {}
  }
  child.kill(signal) // Windows
}

function abortError(bin: string): Error {
  const error = new Error(`aborted: ${bin}`)
  error.name = 'AbortError'
  return error
}

/** Turns arbitrary chunks into whole lines by subprocesses. Maintains buffer with flush.
 *  Used to process yt-dlp and ffmpeg output. */
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

/**
 * Main process function. Spawns a child process on binary `bin` and calls stdout and stderr
 * on each outputed line by process.
 */
export const runLines: RunLines = ({
  bin,
  args,
  onStdout,
  onStderr,
  signal,
  killGraceMs = KILL_GRACE_MS,
  env
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

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32', // orphan child handling
      env
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
