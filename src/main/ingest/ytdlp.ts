import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, ProbeResult } from '../../shared/types'
import type { RunLines } from './spawnLines'

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
  const tail = stderrTail.filter((line) => line.trim() !== '').join('\n')
  const error = new Error(tail === '' ? message : `${message}:\n${tail}`)
  error.name = 'YtDlpError'
  return error
}

export interface ResolveYtDlpPathOptions {
  // Dev: `<repo>/resources/bin/<platform>`. Packaged: `<process.resourcesPath>/bin`
  resourcesBinDir: string
  platform: NodeJS.Platform
}

export function resolveYtDlpPath({ resourcesBinDir, platform }: ResolveYtDlpPathOptions): string {
  return path.join(resourcesBinDir, assetName(platform))
}

// yt-dlp requires JS runtime path -> fetch from Electron app itself
function jsRuntimeArgs(jsRuntimePath: string | undefined): string[] {
  return jsRuntimePath === undefined ? [] : ['--js-runtimes', `node:${jsRuntimePath}`]
}

function jsRuntimeEnv(jsRuntimePath: string | undefined): NodeJS.ProcessEnv | undefined {
  return jsRuntimePath === undefined ? undefined : { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
}

// Probe URL for info
export function buildProbeArgs(url: string, jsRuntimePath?: string): string[] {
  return [
    ...jsRuntimeArgs(jsRuntimePath),
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
    const parsed: unknown = JSON.parse(candidate)
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
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
}

export async function probe({
  url,
  run,
  binPath,
  timeoutMs = PROBE_TIMEOUT_MS,
  jsRuntimePath
}: ProbeOptions): Promise<ProbeResult> {
  const stdout: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  let code: number
  let stderrTail: string[]
  try {
    ;({ code, stderrTail } = await run({
      bin: binPath,
      args: buildProbeArgs(url, jsRuntimePath),
      onStdout: (line) => stdout.push(line),
      signal: controller.signal,
      env: jsRuntimeEnv(jsRuntimePath)
    }))
  } catch (error) {
    if (controller.signal.aborted) {
      // timeout called
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
  outTemplate: string
  // Directory holding the ffmpeg binary — yt-dlp needs it to merge/extract audio
  ffmpegDir: string
  jsRuntimePath?: string
}

export function buildDownloadArgs({
  url,
  outTemplate,
  ffmpegDir,
  jsRuntimePath
}: BuildDownloadArgsOptions): string[] {
  return [
    ...jsRuntimeArgs(jsRuntimePath),
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
  signal,
  jsRuntimePath
}: DownloadOptions): Promise<string> {
  const printed: string[] = []
  const { code, stderrTail } = await run({
    bin: binPath,
    args: buildDownloadArgs({ url, outTemplate, ffmpegDir, jsRuntimePath }),
    env: jsRuntimeEnv(jsRuntimePath),
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
