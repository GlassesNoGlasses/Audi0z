import { spawn } from 'node:child_process'

/** The only module allowed to import `node:child_process`; ffmpeg and yt-dlp take a `RunLines`. */

export interface RunLinesOptions {
  bin: string // binary absolute path
  args: string[]
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  signal?: AbortSignal
  killGraceMs?: number
  // Merged over this process's env, never swapped for it: a child losing PATH/TMPDIR (or
  // SystemRoot) fails oddly. Omitted = plain inherit.
  envOverrides?: Record<string, string>
}

export interface RunLinesResult {
  code: number // exite code (-1 if dies)
  stderrTail: string[] // stderr last line for error
}

export type RunLines = (opts: RunLinesOptions) => Promise<RunLinesResult>
export const STDERR_TAIL_LINES = 20

/** `name` is contract: the renderer recognises failures by the serialised `<Name>: <message>`. */
export function processError(name: string, message: string, stderrTail: string[]): Error {
  const tail = stderrTail.filter((line) => line.trim() !== '').join('\n')
  const error = new Error(tail === '' ? message : `${message}:\n${tail}`)
  error.name = name
  return error
}

// How long a cancelled process group has to honour SIGTERM before SIGKILL settles it
export const KILL_GRACE_MS = 5000

export interface KillableChild {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
}

/** Signals a child and every *grandchild* — yt-dlp spawns ffmpeg of its own. */
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

/** Turns arbitrary subprocess chunks into whole lines, buffering the partial tail until `flush`. */
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

/** Spawns `bin` and calls `onStdout`/`onStderr` with each whole line the child prints. */
export const runLines: RunLines = ({
  bin,
  args,
  onStdout,
  onStderr,
  signal,
  killGraceMs = KILL_GRACE_MS,
  envOverrides
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
      env: envOverrides === undefined ? undefined : { ...process.env, ...envOverrides }
    })

    const onStdoutChunk = (chunk: string): void => stdout.push(chunk)
    const onStderrChunk = (chunk: string): void => stderr.push(chunk)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', onStdoutChunk)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', onStderrChunk)

    // `unref` as well as `clearTimeout`: neither may be what keeps the process alive.
    let killTimer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      killProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), killGraceMs)
      killTimer.unref?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // Every settle path flushes the partial line in each buffer; no later chunk reaches the caller.
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      child.stdout?.off('data', onStdoutChunk)
      child.stderr?.off('data', onStderrChunk)
      stdout.flush()
      stderr.flush()
      finish()
    }

    child.on('error', (error) => settle(() => reject(error)))

    // `close` rather than `exit`: it fires once stdio is drained, so no output is lost.
    child.on('close', (code) =>
      settle(() => {
        if (signal?.aborted) {
          reject(abortError(bin))
          return
        }
        resolve({ code: code ?? -1, stderrTail })
      })
    )
  })
