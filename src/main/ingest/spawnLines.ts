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
}

export interface RunLinesResult {
  /** The child's exit code (`-1` when it died without one). Callers decide what nonzero means. */
  code: number
  /** The last `STDERR_TAIL_LINES` stderr lines — enough context for an error message. */
  stderrTail: string[]
}

export type RunLines = (opts: RunLinesOptions) => Promise<RunLinesResult>

export const STDERR_TAIL_LINES = 20

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

export const runLines: RunLines = ({ bin, args, onStdout, onStderr, signal }) =>
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
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))

    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
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
