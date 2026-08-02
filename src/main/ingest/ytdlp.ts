import { access, chmod, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, ProbeResult } from '../../shared/types'
import type { RunLines } from './spawnLines'

/**
 * Everything that talks to the bundled standalone `yt-dlp` binary: locating it, probing a URL,
 * downloading, and the in-place self-update. No `electron` import — directories are injected.
 */

/** Release asset names, kept verbatim so `scripts/fetch-ytdlp.mjs` and this module agree. */
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
  const tail = stderrTail.filter((line) => line.trim() !== '').join('\n')
  const error = new Error(tail === '' ? message : `${message}:\n${tail}`)
  error.name = 'YtDlpError'
  return error
}

export interface ResolveYtDlpPathOptions {
  /** `<userData>/bin` — where a self-updated copy lands. */
  userDataBinDir: string
  /** Dev: `<repo>/resources/bin/<platform>`. Packaged: `<process.resourcesPath>/bin`. */
  resourcesBinDir: string
  platform: NodeJS.Platform
  exists(p: string): boolean
}

/** The self-updated copy wins; the shipped one is the fallback. */
export function resolveYtDlpPath({
  userDataBinDir,
  resourcesBinDir,
  platform,
  exists
}: ResolveYtDlpPathOptions): string {
  const asset = assetName(platform)
  const updated = path.join(userDataBinDir, asset)
  return exists(updated) ? updated : path.join(resourcesBinDir, asset)
}

export function buildProbeArgs(url: string): string[] {
  return ['--no-playlist', '--skip-download', '--dump-single-json', '--no-color', url]
}

/**
 * `--dump-single-json` writes one JSON object to stdout, but extractors sometimes precede it with
 * chatter, so both the whole stdout and any single JSON-looking line are tried.
 */
function parseDump(stdout: string[]): Record<string, unknown> {
  const candidates = [
    stdout.join('\n'),
    ...stdout.filter((line) => line.trimStart().startsWith('{'))
  ]
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // Not this candidate — fall through to the next one.
    }
  }
  throw new Error('yt-dlp did not return JSON on stdout')
}

/**
 * How long a probe may run before it is killed.
 *
 * Nothing in the UI can cancel a probe — `download:cancel` only reaches a running download — so an
 * extractor that hangs (a dead host, a captcha wall, a stalled TLS handshake) would leave the Add
 * dialog waiting on a promise that never settles. Generous enough for a slow extractor on a slow
 * connection; short enough that the user gets an answer.
 */
export const PROBE_TIMEOUT_MS = 30_000

export interface ProbeOptions {
  url: string
  run: RunLines
  binPath: string
  /** Wall-clock bound on the whole probe. Defaults to `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number
}

export async function probe({
  url,
  run,
  binPath,
  timeoutMs = PROBE_TIMEOUT_MS
}: ProbeOptions): Promise<ProbeResult> {
  const stdout: string[] = []
  // The timeout is spent as an abort so the child is actually killed, not merely stopped waiting on.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  let code: number
  let stderrTail: string[]
  try {
    ;({ code, stderrTail } = await run({
      bin: binPath,
      args: buildProbeArgs(url),
      onStdout: (line) => stdout.push(line),
      signal: controller.signal
    }))
  } catch (error) {
    // The runner reports an abort in its own words; the user needs to know it was the clock.
    if (controller.signal.aborted) {
      throw ytDlpError(`yt-dlp probe timed out after ${Math.round(timeoutMs / 1000)}s`, [])
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (code !== 0) throw ytDlpError(`yt-dlp probe failed (exit ${code})`, stderrTail)

  const dump = parseDump(stdout)
  const result: ProbeResult = {
    title: typeof dump.title === 'string' ? dump.title : '',
    sourceUrl: url
  }
  if (typeof dump.duration === 'number' && Number.isFinite(dump.duration)) {
    result.durationSec = dump.duration
  }
  return result
}

export interface BuildDownloadArgsOptions {
  url: string
  /** A yt-dlp output template, e.g. `<tempJobDir>/download.%(ext)s`. */
  outTemplate: string
  /** Directory holding the ffmpeg binary — yt-dlp needs it to merge/extract audio. */
  ffmpegDir: string
}

export function buildDownloadArgs({
  url,
  outTemplate,
  ffmpegDir
}: BuildDownloadArgsOptions): string[] {
  return [
    '--no-playlist',
    '--no-color',
    '--newline',
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '--ffmpeg-location',
    ffmpegDir,
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

/**
 * Parses one `--progress-template` line. Anything else — extractor chatter, the `after_move`
 * filepath — returns null, which is how `download` tells progress from output paths.
 */
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

export interface DownloadOptions extends BuildDownloadArgsOptions {
  run: RunLines
  binPath: string
  onProgress?: (progress: DownloadProgress) => void
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
  signal
}: DownloadOptions): Promise<string> {
  const printed: string[] = []
  const { code, stderrTail } = await run({
    bin: binPath,
    args: buildDownloadArgs({ url, outTemplate, ffmpegDir }),
    onStdout: (line) => {
      const progress = parseProgressLine(line)
      if (progress) {
        onProgress?.(progress)
        return
      }
      const trimmed = line.trim()
      if (trimmed !== '') printed.push(trimmed)
    },
    signal
  })

  if (code !== 0) throw ytDlpError(`yt-dlp download failed (exit ${code})`, stderrTail)

  const filePath = printed.at(-1)
  if (!filePath) throw new Error('yt-dlp finished without printing an output path')
  return filePath
}

/** The slice of `node:fs/promises` the self-update needs, so tests can hand it a fake. */
export interface YtDlpFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<unknown>
  access(p: string): Promise<void>
  copyFile(src: string, dst: string): Promise<void>
  chmod(p: string, mode: number): Promise<void>
}

const nodeFs: YtDlpFs = { mkdir, access, copyFile, chmod }

async function pathExists(fs: YtDlpFs, p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export interface UpdateYtDlpOptions {
  /** `<userData>/bin` — writable, unlike the app bundle. */
  userDataBinDir: string
  /** The shipped binary, copied in on first update. */
  bundledPath: string
  run: RunLines
  fs?: YtDlpFs
}

/**
 * yt-dlp updates itself in place, so the update always runs against a writable copy in userData —
 * never against the read-only one inside the app bundle.
 */
export async function updateYtDlp({
  userDataBinDir,
  bundledPath,
  run,
  fs = nodeFs
}: UpdateYtDlpOptions): Promise<{ version: string }> {
  // Same basename as the bundled asset, so `resolveYtDlpPath` finds this copy afterwards.
  const target = path.join(userDataBinDir, path.basename(bundledPath))

  await fs.mkdir(userDataBinDir, { recursive: true })
  if (!(await pathExists(fs, target))) {
    await fs.copyFile(bundledPath, target)
    await fs.chmod(target, 0o755)
  }

  const updated = await run({ bin: target, args: ['--update-to', 'stable'] })
  if (updated.code !== 0) {
    throw ytDlpError(`yt-dlp update failed (exit ${updated.code})`, updated.stderrTail)
  }

  const versionLines: string[] = []
  const version = await run({
    bin: target,
    args: ['--version'],
    onStdout: (line) => versionLines.push(line)
  })
  if (version.code !== 0) {
    throw ytDlpError(`yt-dlp --version failed (exit ${version.code})`, version.stderrTail)
  }

  const reported = versionLines.at(-1)?.trim() ?? ''
  if (reported === '') throw new Error('yt-dlp did not report a version')
  return { version: reported }
}
