import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTranscodeArgs, resolveFfmpegPath, transcode } from './ffmpeg'
import type { RunLines } from './spawnLines'

describe('buildTranscodeArgs', () => {
  it('builds the fixed 96k opus argument list', () => {
    const args = buildTranscodeArgs('/in/song.mp3', '/out/song.opus.part')

    expect(args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      '/in/song.mp3',
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'opus',
      '/out/song.opus.part'
    ])
    expect(args.indexOf('/in/song.mp3')).toBeLessThan(args.indexOf('/out/song.opus.part'))
    // `-f opus` is not decoration: the output is staged as `<name>.opus.part`, and without an
    // explicit format ffmpeg would try to infer the container from `.part` and give up.
    expect(args.indexOf('-f')).toBeLessThan(args.indexOf('/out/song.opus.part'))
  })
})

describe('resolveFfmpegPath', () => {
  const asarPath = path.join(
    '/App',
    'Resources',
    'app.asar',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg'
  )

  it('throws when ffmpeg-static resolved to null', () => {
    expect(() => resolveFfmpegPath({ ffmpegStaticPath: null, isPackaged: false })).toThrow(
      /ffmpeg/i
    )
  })

  it('leaves the path alone when the app is not packaged', () => {
    expect(resolveFfmpegPath({ ffmpegStaticPath: asarPath, isPackaged: false })).toBe(asarPath)
  })

  it('rewrites app.asar to app.asar.unpacked when the app is packaged', () => {
    expect(resolveFfmpegPath({ ffmpegStaticPath: asarPath, isPackaged: true })).toBe(
      asarPath.replace('app.asar', 'app.asar.unpacked')
    )
  })

  it('does not double-rewrite an already-unpacked path', () => {
    const unpacked = asarPath.replace('app.asar', 'app.asar.unpacked')
    expect(resolveFfmpegPath({ ffmpegStaticPath: unpacked, isPackaged: true })).toBe(unpacked)
  })
})

describe('transcode', () => {
  let dir = ''
  let src = ''
  let dst = ''

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mml-ffmpeg-'))
    src = path.join(dir, 'source.wav')
    dst = path.join(dir, 'target.opus')
    await writeFile(src, 'not really audio')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Stands in for ffmpeg: writes whatever the last arg names, then exits with `code`. */
  function fakeFfmpeg(code: number, stderrTail: string[] = []): RunLines {
    return vi.fn(async ({ args, onStderr }) => {
      await writeFile(args[args.length - 1], 'transcoded bytes')
      for (const line of stderrTail) onStderr?.(line)
      return { code, stderrTail }
    })
  }

  it('writes to a .part file and renames it onto dst on exit 0', async () => {
    const run = fakeFfmpeg(0)

    await expect(transcode({ src, dst, run, ffmpegPath: '/bin/ffmpeg' })).resolves.toBeUndefined()

    expect(run).toHaveBeenCalledTimes(1)
    const call = vi.mocked(run).mock.calls[0][0]
    expect(call.bin).toBe('/bin/ffmpeg')
    expect(call.args).toEqual(buildTranscodeArgs(src, `${dst}.part`))
    expect(existsSync(dst)).toBe(true)
    expect(existsSync(`${dst}.part`)).toBe(false)
  })

  it('rejects with the stderr tail and leaves no .part behind on a nonzero exit', async () => {
    const run = fakeFfmpeg(1, ['Invalid data found', 'Conversion failed!'])

    await expect(transcode({ src, dst, run, ffmpegPath: '/bin/ffmpeg' })).rejects.toThrow(
      /Conversion failed!/
    )
    expect(existsSync(`${dst}.part`)).toBe(false)
    expect(existsSync(dst)).toBe(false)
  })

  it('cleans up the .part file when the spawn itself fails', async () => {
    const run: RunLines = vi.fn(async ({ args }) => {
      await writeFile(args[args.length - 1], 'half a file')
      throw new Error('spawn ENOENT')
    })

    await expect(transcode({ src, dst, run, ffmpegPath: '/bin/ffmpeg' })).rejects.toThrow(
      /spawn ENOENT/
    )
    expect(existsSync(`${dst}.part`)).toBe(false)
    expect(existsSync(dst)).toBe(false)
  })
})
