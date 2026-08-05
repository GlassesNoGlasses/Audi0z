import { rename, rm } from 'node:fs/promises'
import { runLines, type RunLines } from './spawnLines'

/**
 * The optional transcode-to-Opus step. No `electron` import: the caller resolves and injects the
 * `ffmpeg-static` path and whether the app is packaged.
 */

export interface ResolveFfmpegPathOptions {
  /** `require('ffmpeg-static')` — typed as nullable because it resolves to null on odd platforms. */
  ffmpegStaticPath: string | null
  isPackaged: boolean
}

/**
 * In a packaged build the binary is unpacked out of the asar archive (electron-builder's
 * `asarUnpack`), but `ffmpeg-static` still reports the in-archive path, so it needs rewriting.
 */
export function resolveFfmpegPath({
  ffmpegStaticPath,
  isPackaged
}: ResolveFfmpegPathOptions): string {
  if (!ffmpegStaticPath) {
    throw new Error('ffmpeg binary not found: ffmpeg-static resolved to null on this platform')
  }
  if (!isPackaged || ffmpegStaticPath.includes('app.asar.unpacked')) return ffmpegStaticPath
  return ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
}

/**
 * Audio only (`-vn`, so cover art never becomes a video stream), metadata stripped, Opus 96k.
 * `-nostdin` matters because the child's stdin is ignored — ffmpeg must not wait on it.
 *
 * 96k, not 128k: the downloader fetches `bestaudio[ext=m4a]`, already ~128k AAC, so a 128k target
 * asked Opus to match its own source. Ogg overhead and unconstrained VBR overshoot ate what little
 * was left, and the re-encode could land *bigger* than the file it replaced. 96k is
 * near-transparent for music and sits far enough under those sources to actually shrink them.
 *
 * `-f opus` is required, not belt-and-braces: the output is staged as `<name>.opus.part`, and
 * ffmpeg infers the container from the file extension, so `.part` would fail the run outright with
 * "Unable to find a suitable output format".
 */
export function buildTranscodeArgs(src: string, dst: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    src,
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    '-f',
    'opus',
    dst
  ]
}

export interface TranscodeOptions {
  src: string
  dst: string
  ffmpegPath: string
  /** Injected for tests; defaults to the real child-process runner. */
  run?: RunLines
}

/**
 * Transcodes `src` to `dst`, via `dst.part` so a crash or a failed run can never leave a truncated
 * file where the library expects a playable one.
 */
export async function transcode({
  src,
  dst,
  ffmpegPath,
  run = runLines
}: TranscodeOptions): Promise<void> {
  const partPath = `${dst}.part`

  let result
  try {
    result = await run({ bin: ffmpegPath, args: buildTranscodeArgs(src, partPath) })
  } catch (error) {
    await rm(partPath, { force: true })
    throw error
  }

  if (result.code !== 0) {
    await rm(partPath, { force: true })
    const tail = result.stderrTail.filter((line) => line.trim() !== '').join('\n')
    const error = new Error(
      tail === ''
        ? `ffmpeg exited with code ${result.code}`
        : `ffmpeg exited with code ${result.code}:\n${tail}`
    )
    error.name = 'FfmpegError'
    throw error
  }

  try {
    await rename(partPath, dst)
  } catch (error) {
    await rm(partPath, { force: true })
    throw error
  }
}
