import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, ProbeResult } from '../../shared/types'
import { processError, type RunLines } from './spawnLines'

const ASSETS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux'
}

function assetName(platform: NodeJS.Platform): string {
  const asset = ASSETS[platform]
  if (!asset) throw new Error(`no bundled yt-dlp binary for platform ${platform}`)
  return asset
}

function ytDlpError(message: string, stderrTail: string[]): Error {
  return processError('YtDlpError', message, stderrTail)
}

export interface ResolveYtDlpPathOptions {
  // Dev: `<repo>/resources/bin/<platform>`. Packaged: `<process.resourcesPath>/bin`
  resourcesBinDir: string
  platform: NodeJS.Platform
}

export function resolveYtDlpPath({ resourcesBinDir, platform }: ResolveYtDlpPathOptions): string {
  return path.join(resourcesBinDir, assetName(platform))
}

export interface YtDlpRuntime {
  args: string[]
  envOverrides?: Record<string, string>
}

// `--no-js-runtimes` must precede `--js-runtimes node:`, or a deno on PATH preempts the pin.
// ELECTRON_RUN_AS_NODE pairs with the args: args alone open a second app, env alone finds none.
/** yt-dlp requires a JS runtime path -> fetch from Electron app itself, run as plain Node. */
export function ytDlpRuntime(jsRuntimePath: string | undefined): YtDlpRuntime {
  if (jsRuntimePath === undefined) return { args: [] }
  return {
    args: ['--no-js-runtimes', '--js-runtimes', `node:${jsRuntimePath}`],
    envOverrides: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export function buildProbeArgs(url: string, runtimeArgs: string[] = []): string[] {
  return [
    ...runtimeArgs,
    '--no-playlist',
    '--skip-download',
    '--dump-single-json',
    '--no-color',
    url
  ]
}

/** Handles `--dump-single-json` edge cases (sometimes it's not a single json...) */
function parseDump(stdout: string[]): Record<string, unknown> {
  const candidates = [
    stdout.join('\n'),
    ...stdout.filter((line) => line.trimStart().startsWith('{'))
  ]
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    // The whole of stdout stops parsing the moment yt-dlp prints a warning above the dump.
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {}
  }
  throw new Error('yt-dlp did not return JSON on stdout')
}

export const PROBE_TIMEOUT_MS = 60_000

export interface ProbeOptions {
  url: string
  run: RunLines
  binPath: string
  timeoutMs?: number
  jsRuntimePath?: string
  signal?: AbortSignal // the caller's cancel, on top of the timeout below
}

export async function probe({
  url,
  run,
  binPath,
  timeoutMs = PROBE_TIMEOUT_MS,
  jsRuntimePath,
  signal
}: ProbeOptions): Promise<ProbeResult> {
  const stdout: string[] = []
  const { args: runtimeArgs, envOverrides } = ytDlpRuntime(jsRuntimePath)
  const controller = new AbortController()

  // One signal carries both the timeout and the caller's cancel; `timedOut` separates them after.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  const onCallerAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onCallerAbort, { once: true })

  let code: number
  let stderrTail: string[]
  try {
    ;({ code, stderrTail } = await run({
      bin: binPath,
      args: buildProbeArgs(url, runtimeArgs),
      onStdout: (line) => stdout.push(line),
      signal: controller.signal,
      envOverrides
    }))
  } catch (error) {
    if (timedOut) {
      throw ytDlpError(`yt-dlp probe timed out after ${Math.round(timeoutMs / 1000)}s`, [])
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
  if (code !== 0) throw ytDlpError(`yt-dlp probe failed (exit ${code})`, stderrTail)

  const dump = parseDump(stdout)
  return {
    title: typeof dump.title === 'string' ? dump.title : '',
    sourceUrl: url
  }
}

export interface BuildDownloadArgsOptions {
  url: string
  outTemplate: string
  // Directory holding the ffmpeg binary — yt-dlp needs it to merge/extract audio
  ffmpegDir: string
  /** `ytDlpRuntime(...).args`, when a runtime is wired. */
  runtimeArgs?: string[]
}

export function buildDownloadArgs({
  url,
  outTemplate,
  ffmpegDir,
  runtimeArgs = []
}: BuildDownloadArgsOptions): string[] {
  return [
    ...runtimeArgs,
    '--no-playlist',
    '--no-color',
    '--newline',
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '--ffmpeg-location',
    ffmpegDir,
    '--progress',
    '--progress-template',
    'PROGRESS:%(progress.downloaded_bytes)s/%(progress.total_bytes)s',
    '--print',
    'after_move:filepath',
    '-o',
    outTemplate,
    url
  ]
}

const PROGRESS_PREFIX = 'PROGRESS:'

export function parseProgressLine(line: string): DownloadProgress | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null
  const [rawBytes, rawTotal] = line.slice(PROGRESS_PREFIX.length).split('/')

  const bytes = Number(rawBytes)
  if (rawBytes === undefined || rawBytes.trim() === '' || !Number.isFinite(bytes)) return null

  // yt-dlp prints `NA` for a field it does not know yet (live streams, some extractors).
  const total = Number(rawTotal)
  const hasTotal =
    rawTotal !== undefined && rawTotal.trim() !== '' && Number.isFinite(total) && total > 0

  const progress: DownloadProgress = {
    stage: 'downloading',
    bytes,
    percent: hasTotal ? Math.min(100, Math.round((bytes / total) * 100)) : null
  }
  if (hasTotal) progress.totalBytes = total
  return progress
}

// yt-dlp exits 0 on a failed JS challenge and reports it on stderr only.
const CHALLENGE_FAILURE =
  /challenge solving failed|error solving \d+ challenge|No supported JavaScript runtime/i

const CHALLENGE_WARNING =
  'YouTube signature check failed — this download may be slow or incomplete.'

export interface DownloadOptions extends Omit<BuildDownloadArgsOptions, 'runtimeArgs'> {
  jsRuntimePath?: string
  run: RunLines
  binPath: string
  onProgress?: (progress: DownloadProgress) => void
  onWarning?: (message: string) => void // the run finished, but not as intended
  signal?: AbortSignal
}

/** Resolves with the absolute path yt-dlp printed via `--print after_move:filepath`. */
export async function download({
  url,
  outTemplate,
  ffmpegDir,
  run,
  binPath,
  onProgress,
  onWarning,
  signal,
  jsRuntimePath
}: DownloadOptions): Promise<string> {
  const printed: string[] = []
  let challengeFailed = false
  const { args: runtimeArgs, envOverrides } = ytDlpRuntime(jsRuntimePath)

  const { code, stderrTail } = await run({
    bin: binPath,
    args: buildDownloadArgs({ url, outTemplate, ffmpegDir, runtimeArgs }),
    envOverrides,
    onStdout: (line) => {
      const progress = parseProgressLine(line)
      if (progress) {
        onProgress?.(progress)
        return
      }
      const trimmed = line.trim()
      if (trimmed !== '') printed.push(trimmed)
    },
    onStderr: (line) => {
      if (CHALLENGE_FAILURE.test(line)) challengeFailed = true
    },
    signal
  })

  if (code !== 0) throw ytDlpError(`yt-dlp download failed (exit ${code})`, stderrTail)

  const filePath = printed.at(-1)
  if (!filePath) throw new Error('yt-dlp finished without printing an output path')

  if (challengeFailed) onWarning?.(CHALLENGE_WARNING)
  return filePath
}

export interface CleanupFs {
  rm(p: string, opts: { force: boolean }): Promise<void>
}

export interface RemoveSelfUpdatedYtDlpOptions {
  userDataBinDir: string
  platform: NodeJS.Platform
  fs?: CleanupFs
}

/** Deletes a self-updated copy an older build left, so the pinned binary runs. Best-effort. */
export async function removeSelfUpdatedYtDlp({
  userDataBinDir,
  platform,
  fs = { rm }
}: RemoveSelfUpdatedYtDlpOptions): Promise<void> {
  try {
    await fs.rm(path.join(userDataBinDir, assetName(platform)), { force: true })
  } catch {}
}
