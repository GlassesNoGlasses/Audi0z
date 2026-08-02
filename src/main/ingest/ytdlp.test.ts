import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadProgress } from '../../shared/types'
import type { RunLines, RunLinesResult } from './spawnLines'
import {
  buildDownloadArgs,
  buildProbeArgs,
  download,
  parseProgressLine,
  probe,
  resolveYtDlpPath,
  updateYtDlp
} from './ytdlp'

/** A `runLines` stand-in that replays canned output and exits with `code`. */
function fakeRun(stdout: string[], code = 0, stderrTail: string[] = []): RunLines {
  return vi.fn(async ({ onStdout, onStderr }) => {
    for (const line of stdout) onStdout?.(line)
    for (const line of stderrTail) onStderr?.(line)
    return { code, stderrTail }
  })
}

describe('resolveYtDlpPath', () => {
  const userDataBinDir = path.join('/userData', 'bin')
  const resourcesBinDir = path.join('/resources', 'bin', 'darwin')

  it.each([
    ['darwin' as const, 'yt-dlp_macos'],
    ['win32' as const, 'yt-dlp.exe'],
    ['linux' as const, 'yt-dlp_linux']
  ])('uses the %s release asset name', (platform, asset) => {
    expect(
      resolveYtDlpPath({ userDataBinDir, resourcesBinDir, platform, exists: () => false })
    ).toBe(path.join(resourcesBinDir, asset))
  })

  it('prefers the self-updated userData copy when it exists', () => {
    const preferred = path.join(userDataBinDir, 'yt-dlp_macos')
    const exists = vi.fn((p: string) => p === preferred)

    expect(resolveYtDlpPath({ userDataBinDir, resourcesBinDir, platform: 'darwin', exists })).toBe(
      preferred
    )
    expect(exists).toHaveBeenCalledWith(preferred)
  })

  it('throws on a platform with no bundled binary', () => {
    expect(() =>
      resolveYtDlpPath({
        userDataBinDir,
        resourcesBinDir,
        platform: 'freebsd',
        exists: () => false
      })
    ).toThrow(/freebsd/)
  })
})

describe('buildProbeArgs', () => {
  it('asks for a single-entry JSON dump without downloading', () => {
    expect(buildProbeArgs('https://example.test/watch?v=1')).toEqual([
      '--no-playlist',
      '--skip-download',
      '--dump-single-json',
      '--no-color',
      'https://example.test/watch?v=1'
    ])
  })
})

describe('probe', () => {
  const url = 'https://example.test/watch?v=1'

  it('parses the title and duration out of the JSON dump', async () => {
    const run = fakeRun([JSON.stringify({ title: 'Some Remix', duration: 245, id: 'abc' })])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp' })).resolves.toEqual({
      title: 'Some Remix',
      durationSec: 245,
      sourceUrl: url
    })
    expect(vi.mocked(run).mock.calls[0][0].args).toEqual(buildProbeArgs(url))
  })

  it('omits the duration when yt-dlp reports none', async () => {
    const run = fakeRun([JSON.stringify({ title: 'Live stream', duration: null })])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp' })).resolves.toEqual({
      title: 'Live stream',
      sourceUrl: url
    })
  })

  it('rejects descriptively when stdout is not JSON', async () => {
    const run = fakeRun(['WARNING: something', 'not json at all'])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp' })).rejects.toThrow(/yt-dlp .*JSON|JSON/i)
  })

  it('rejects with the stderr tail on a nonzero exit', async () => {
    const run = fakeRun([], 1, ['ERROR: Unsupported URL: https://example.test/watch?v=1'])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp' })).rejects.toThrow(/Unsupported URL/)
  })

  /**
   * A probe has no cancel button behind it — `download:cancel` only reaches a running download —
   * so an extractor that hangs would otherwise leave the Add dialog waiting forever.
   */
  it('aborts and rejects when yt-dlp outlives the timeout', async () => {
    const run: RunLines = vi.fn(
      ({ signal }) =>
        new Promise<RunLinesResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('aborted: /bin/yt-dlp')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    await expect(probe({ url, run, binPath: '/bin/yt-dlp', timeoutMs: 10 })).rejects.toThrow(
      /timed out/i
    )
  })

  it('leaves the timeout unarmed once the probe answers', async () => {
    const run = fakeRun([JSON.stringify({ title: 'Quick' })])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp', timeoutMs: 5 })).resolves.toMatchObject({
      title: 'Quick'
    })
    // Long enough that a timer left running would have fired by now — and the abort it triggers
    // would surface as an unhandled rejection rather than a passing test.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})

describe('buildDownloadArgs', () => {
  it('selects bestaudio, forces newline progress and prints the final path', () => {
    expect(
      buildDownloadArgs({
        url: 'https://example.test/v/1',
        outTemplate: '/tmp/job/download.%(ext)s',
        ffmpegDir: '/opt/ffmpeg'
      })
    ).toEqual([
      '--no-playlist',
      '--no-color',
      '--newline',
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',
      '--ffmpeg-location',
      '/opt/ffmpeg',
      '--progress-template',
      'PROGRESS:%(progress.downloaded_bytes)s/%(progress.total_bytes)s',
      '--print',
      'after_move:filepath',
      '-o',
      '/tmp/job/download.%(ext)s',
      'https://example.test/v/1'
    ])
  })
})

describe('parseProgressLine', () => {
  it('computes a percentage when the total is known', () => {
    expect(parseProgressLine('PROGRESS:1024/4096')).toEqual({
      stage: 'downloading',
      bytes: 1024,
      totalBytes: 4096,
      percent: 25
    })
  })

  it('reports a null percentage when the total is unknown', () => {
    expect(parseProgressLine('PROGRESS:1024/NA')).toEqual({
      stage: 'downloading',
      bytes: 1024,
      percent: null
    })
  })

  it('returns null for anything that is not a progress line', () => {
    expect(parseProgressLine('/tmp/job/download.m4a')).toBeNull()
    expect(parseProgressLine('[youtube] Extracting URL')).toBeNull()
    expect(parseProgressLine('PROGRESS:nonsense')).toBeNull()
    expect(parseProgressLine('')).toBeNull()
  })
})

describe('download', () => {
  const base = {
    url: 'https://example.test/v/1',
    outTemplate: '/tmp/job/download.%(ext)s',
    ffmpegDir: '/opt/ffmpeg',
    binPath: '/bin/yt-dlp'
  }

  it('emits progress in order and resolves with the after_move path', async () => {
    const run = fakeRun([
      '[youtube] Extracting URL',
      'PROGRESS:1024/4096',
      'PROGRESS:2048/4096',
      'PROGRESS:4096/4096',
      '/tmp/job/download.m4a'
    ])
    const seen: DownloadProgress[] = []

    await expect(download({ ...base, run, onProgress: (p) => seen.push(p) })).resolves.toBe(
      '/tmp/job/download.m4a'
    )

    expect(seen.map((p) => p.percent)).toEqual([25, 50, 100])
    expect(seen.map((p) => p.bytes)).toEqual([1024, 2048, 4096])
    expect(vi.mocked(run).mock.calls[0][0].args).toEqual(buildDownloadArgs(base))
  })

  it('rejects with the stderr tail on a nonzero exit', async () => {
    const run = fakeRun(['PROGRESS:1024/4096'], 1, [
      'ERROR: unable to download video data: HTTP Error 403'
    ])

    await expect(download({ ...base, run })).rejects.toThrow(/HTTP Error 403/)
  })

  it('rejects when yt-dlp never printed an output path', async () => {
    const run = fakeRun(['PROGRESS:1024/4096'])

    await expect(download({ ...base, run })).rejects.toThrow(/path/i)
  })

  it('forwards the abort signal to the child runner', async () => {
    const controller = new AbortController()
    const run = fakeRun(['/tmp/job/download.m4a'])

    await download({ ...base, run, signal: controller.signal })

    expect(vi.mocked(run).mock.calls[0][0].signal).toBe(controller.signal)
  })
})

describe('updateYtDlp', () => {
  const userDataBinDir = path.join('/userData', 'bin')
  const bundledPath = path.join('/resources', 'bin', 'darwin', 'yt-dlp_macos')
  const copyPath = path.join(userDataBinDir, 'yt-dlp_macos')

  function fakeFs(copyExists: boolean) {
    return {
      mkdir: vi.fn(async () => undefined),
      access: vi.fn(async () => {
        if (!copyExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
      copyFile: vi.fn(async () => {}),
      chmod: vi.fn(async () => {})
    }
  }

  /** `--update-to` prints nothing useful; `--version` prints the version. */
  const versionRun: RunLines = vi.fn(async ({ args, onStdout }) => {
    if (args[0] === '--version') onStdout?.('2026.07.04')
    return { code: 0, stderrTail: [] }
  })

  it('copies the bundled binary in when the userData copy is absent, then updates', async () => {
    const fs = fakeFs(false)
    const run = vi.fn(versionRun)

    await expect(updateYtDlp({ userDataBinDir, bundledPath, run, fs })).resolves.toEqual({
      version: '2026.07.04'
    })

    expect(fs.mkdir).toHaveBeenCalledWith(userDataBinDir, { recursive: true })
    expect(fs.copyFile).toHaveBeenCalledWith(bundledPath, copyPath)
    expect(fs.chmod).toHaveBeenCalledWith(copyPath, 0o755)
    expect(run.mock.calls.map((c) => c[0].args)).toEqual([['--update-to', 'stable'], ['--version']])
    expect(run.mock.calls.every((c) => c[0].bin === copyPath)).toBe(true)
  })

  it('does not re-copy when the userData copy already exists', async () => {
    const fs = fakeFs(true)

    await updateYtDlp({ userDataBinDir, bundledPath, run: vi.fn(versionRun), fs })

    expect(fs.copyFile).not.toHaveBeenCalled()
  })

  it('rejects with the stderr tail when the update fails', async () => {
    const run: RunLines = vi.fn(async () => ({
      code: 1,
      stderrTail: ['ERROR: unable to fetch release info']
    }))

    await expect(
      updateYtDlp({ userDataBinDir, bundledPath, run, fs: fakeFs(true) })
    ).rejects.toThrow(/unable to fetch release info/)
  })
})
