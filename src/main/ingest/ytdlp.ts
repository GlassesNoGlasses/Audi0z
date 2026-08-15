import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, ProbeResult } from '../../shared/types'
import type { RunLines } from './spawnLines'

/**
 * Everything that talks to the bundled standalone `yt-dlp` binary: locating it, probing a URL, and
 * downloading. No `electron` import — directories are injected. There is no self-update: the pinned
 * bundled binary is the only one ever run (v3.2), and `removeSelfUpdatedYtDlp` clears the copy older
 * builds may have left in userData.
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
  /** Dev: `<repo>/resources/bin/<platform>`. Packaged: `<process.resourcesPath>/bin`. */
  resourcesBinDir: string
  platform: NodeJS.Platform
}

/** Always the shipped, pinned copy — the in-app self-update was removed in v3.2. */
export function resolveYtDlpPath({ resourcesBinDir, platform }: ResolveYtDlpPathOptions): string {
  return path.join(resourcesBinDir, assetName(platform))
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
 *
 * The budget is dominated by process startup, not by the network: the bundled `yt-dlp_macos` is a
 * PyInstaller onefile binary that unpacks itself on every launch, and `--version` alone — no
 * network at all — measures 25.2s wall (2.2s CPU) on a cold start. Real probes measured 26.4s and
 * 28.9s, so the previous 30s budget was a coin flip and did in fact fail a release gate. 90s keeps
 * roughly 3x headroom over the measured worst case.
 */
export const PROBE_TIMEOUT_MS = 90_000

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
  return {
    title: typeof dump.title === 'string' ? dump.title : '',
    sourceUrl: url
  }
}

export interface BuildDownloadArgsOptions {
  url: string
  /** A yt-dlp output template, e.g. `<tempJobDir>/download.%(ext)s`. */
  outTemplate: string
  /** Directory holding the ffmpeg binary — yt-dlp needs it to merge/extract audio. */
  ffmpegDir: string
}

/**
 * `--progress` and `--print` must stay together: `--print` implies `--quiet`, and `--quiet`
 * suppresses the `--progress-template` output entirely, so without `--progress` the real binary
 * emits zero PROGRESS lines and the renderer's progress bar never moves. Measured against the
 * bundled yt-dlp 2026.07.04 on a real download: 0 progress lines without the flag, 13 with it, and
 * `after_move:filepath` still prints either way. The WP3 plan's arg list omitted `--progress`; the
 * real-download release gate caught it, so this list is the plan's template plus that fix.
 */
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

/** The one fs call the startup cleanup needs, injectable for tests. */
export interface CleanupFs {
  rm(p: string, opts: { force: boolean }): Promise<void>
}

export interface RemoveSelfUpdatedYtDlpOptions {
  /** `<userData>/bin` — where the removed self-update feature used to land its copy. */
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
  } catch {
    // Unsupported platform or an unwritable directory — either way, nothing to clean up.
  }
}
