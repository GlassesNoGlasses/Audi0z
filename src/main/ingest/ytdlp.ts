import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, ProbeResult } from '../../shared/types'
import { processError, type RunLines } from './spawnLines'

// Release asset names
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

/**
 * yt-dlp requires a JS runtime path -> fetch from Electron app itself. `--js-runtimes
 * node:<path>` names the app's own Electron binary, and ELECTRON_RUN_AS_NODE — inherited by the
 * runtime child yt-dlp spawns — is what makes that binary start as plain Node rather than opening
 * a second copy of the app. The two halves are one decision, so one call returns both: args
 * without the env var launch the GUI. `probe` and `download` each make that one call and hand the
 * args half to their builder.
 *
 * `--no-js-runtimes` comes first because the runtime must be deterministic: only deno is enabled
 * by default and it outranks node, so a deno on the user's PATH — of unknown version, possibly
 * broken — would otherwise preempt the known-good runtime this app ships with. yt-dlp's own help
 * prescribes exactly this flag order for using a lower-priority runtime.
 */
export function ytDlpRuntime(jsRuntimePath: string | undefined): YtDlpRuntime {
  if (jsRuntimePath === undefined) return { args: [] }
  return {
    args: ['--no-js-runtimes', '--js-runtimes', `node:${jsRuntimePath}`],
    envOverrides: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

// Probe URL for info. `runtimeArgs` is `ytDlpRuntime(...).args`, when a runtime is wired.
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
    // A candidate that will not parse is the reason the next one exists — the whole of stdout is
    // unparseable the moment yt-dlp prints a warning above the dump.
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

  // The child answers to one signal, so the caller's cancel is folded into it. `timedOut` rather
  // than `controller.signal.aborted` is what separates the two afterwards: a cancel must not be
  // told as a timeout, which names a budget nobody spent.
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

// Download progress
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

/**
 * yt-dlp exits 0 when it cannot solve YouTube's JS challenge: it falls back to a throttled format
 * and reports the failure on stderr alone. The exit code says the download worked, so stderr is
 * the only place a broken JS runtime is visible at all.
 */
// All three spellings captured from live runs of the pinned 2026.07.04 binary.
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

  // Only worth saying once the file is actually here: a run that failed says it louder itself.
  if (challengeFailed) onWarning?.(CHALLENGE_WARNING)
  return filePath
}

// The one fs call the startup cleanup needs
export interface CleanupFs {
  rm(p: string, opts: { force: boolean }): Promise<void>
}

export interface RemoveSelfUpdatedYtDlpOptions {
  userDataBinDir: string
  platform: NodeJS.Platform
  fs?: CleanupFs
}

/**
 * Deletes the self-updated copy an older build may have left behind, so the pinned bundled binary
 * is the one that actually runs. Best-effort by design: a failure here must never break startup,
 * and `force: true` already makes a missing file a non-event.
 */
export async function removeSelfUpdatedYtDlp({
  userDataBinDir,
  platform,
  fs = { rm }
}: RemoveSelfUpdatedYtDlpOptions): Promise<void> {
  try {
    await fs.rm(path.join(userDataBinDir, assetName(platform)), { force: true })
  } catch {}
}
