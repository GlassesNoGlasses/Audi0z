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
  PROBE_TIMEOUT_MS,
  removeSelfUpdatedYtDlp,
  resolveYtDlpPath
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
  const resourcesBinDir = path.join('/resources', 'bin', 'darwin')

  it.each([
    ['darwin' as const, 'yt-dlp_macos'],
    ['win32' as const, 'yt-dlp.exe'],
    ['linux' as const, 'yt-dlp_linux']
  ])('uses the %s release asset name', (platform, asset) => {
    expect(resolveYtDlpPath({ resourcesBinDir, platform })).toBe(path.join(resourcesBinDir, asset))
  })

  it('throws on a platform with no bundled binary', () => {
    expect(() => resolveYtDlpPath({ resourcesBinDir, platform: 'freebsd' })).toThrow(/freebsd/)
  })
})

describe('removeSelfUpdatedYtDlp', () => {
  const userDataBinDir = path.join('/userData', 'bin')

  it('force-removes the platform asset from userData', async () => {
    const rm = vi.fn(async () => undefined)
    await removeSelfUpdatedYtDlp({ userDataBinDir, platform: 'darwin', fs: { rm } })
    expect(rm).toHaveBeenCalledWith(path.join(userDataBinDir, 'yt-dlp_macos'), { force: true })
  })

  it('swallows a failing rm — cleanup must never break startup', async () => {
    const rm = vi.fn(async () => {
      throw new Error('EPERM')
    })
    await expect(
      removeSelfUpdatedYtDlp({ userDataBinDir, platform: 'darwin', fs: { rm } })
    ).resolves.toBeUndefined()
  })

  it('swallows an unsupported platform the same way', async () => {
    const rm = vi.fn(async () => undefined)
    await expect(
      removeSelfUpdatedYtDlp({ userDataBinDir, platform: 'freebsd', fs: { rm } })
    ).resolves.toBeUndefined()
    expect(rm).not.toHaveBeenCalled()
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

  // The renderer measures duration off the `<audio>` element, so the dump's is deliberately dropped.
  it('parses the title out of the JSON dump, leaving the duration beside it', async () => {
    const run = fakeRun([JSON.stringify({ title: 'Some Remix', duration: 245, id: 'abc' })])

    await expect(probe({ url, run, binPath: '/bin/yt-dlp' })).resolves.toEqual({
      title: 'Some Remix',
      sourceUrl: url
    })
    expect(vi.mocked(run).mock.calls[0][0].args).toEqual(buildProbeArgs(url))
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

  /**
   * The default budget is dominated by process startup, not the network: the bundled PyInstaller
   * onefile binary needs ~25s just to reach `--version`, and real probes measured 26.4s and 28.9s.
   * A 30s default failed a release gate; this pins the floor so it cannot be tightened back into
   * coin-flip territory without the measurements being revisited.
   */
  it('defaults to a budget well clear of the measured cold-start cost', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
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
      '--progress',
      '--progress-template',
      'PROGRESS:%(progress.downloaded_bytes)s/%(progress.total_bytes)s',
      '--print',
      'after_move:filepath',
      '-o',
      '/tmp/job/download.%(ext)s',
      'https://example.test/v/1'
    ])
  })

  /**
   * `--print` implies `--quiet`, which silences `--progress-template` — without `--progress` the
   * real binary emits zero PROGRESS lines and the renderer's progress bar never moves. The mocked
   * `download` tests cannot catch that (they inject PROGRESS lines at the `runLines` seam), so the
   * pairing is pinned here against future edits to this arg list.
   */
  it('keeps --progress paired with --print so the progress template survives --quiet', () => {
    const args = buildDownloadArgs({
      url: 'https://example.test/v/1',
      outTemplate: '/tmp/job/download.%(ext)s',
      ffmpegDir: '/opt/ffmpeg'
    })

    expect(args).toContain('--print')
    expect(args).toContain('--progress')
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
