import { rename, rm } from 'node:fs/promises'
import { processError, runLines, type RunLines } from './spawnLines'

export interface ResolveFfmpegPathOptions {
  ffmpegStaticPath: string | null
  isPackaged: boolean
}

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
 * Audio only encoding to Opus 96k. Writes file as `<id>.opus.staged` (temp) -> `<id>.opus` after.
 * `-nostdin` because the child's stdin is ignored — ffmpeg must not wait on it.
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
  run?: RunLines
}

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
    throw processError('FfmpegError', `ffmpeg exited with code ${result.code}`, result.stderrTail)
  }

  try {
    await rename(partPath, dst)
  } catch (error) {
    await rm(partPath, { force: true })
    throw error
  }
}
