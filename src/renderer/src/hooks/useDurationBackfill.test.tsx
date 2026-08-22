import { act, renderHook, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SongDto } from '../../../shared/types'
import { renderApp, seedApi, song, stubDuration, stubMediaElement } from '../testing/harness'
import { useDurationBackfill } from './useDurationBackfill'

stubMediaElement()

/** Every `new Audio()` the hook builds; jsdom resolves none of them, so the tests answer each. */
let probes: HTMLAudioElement[] = []

beforeEach(() => {
  probes = []
  const RealAudio = globalThis.Audio
  vi.stubGlobal('Audio', function FakeAudio(): HTMLAudioElement {
    const audio = new RealAudio()
    probes.push(audio)
    return audio
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Answers the probe the way a real file would. */
async function reportDuration(audio: HTMLAudioElement, seconds: number): Promise<void> {
  await act(async () => {
    stubDuration(audio, seconds)
    audio.dispatchEvent(new Event('loadedmetadata'))
  })
}

/** Answers it the way an unreadable one would. */
async function reportFailure(audio: HTMLAudioElement): Promise<void> {
  await act(async () => {
    audio.dispatchEvent(new Event('error'))
  })
}

interface Props {
  list: SongDto[]
  idle: boolean
}

/** Idle by default: most of these tests are about the probing, not about who yields to whom. */
function backfill(songs: SongDto[], idle = true): ReturnType<typeof renderHook<void, Props>> {
  const dispatch = vi.fn()
  return renderHook(({ list, idle: quiet }: Props) => useDurationBackfill(list, dispatch, quiet), {
    initialProps: { list: songs, idle }
  })
}

describe('useDurationBackfill', () => {
  it('measures a song that has no playing time yet and writes the whole seconds back', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill([song('a', 'Alpha Mix')], dispatch, true))

    await waitFor(() => expect(probes).toHaveLength(1))
    expect(probes[0].getAttribute('preload')).toBe('metadata')
    expect(probes[0].getAttribute('src')).toBe('media://audio/a')

    await reportDuration(probes[0], 183.6)

    await waitFor(() =>
      expect(api.library.updateDurations).toHaveBeenCalledWith([{ id: 'a', durationSec: 184 }])
    )
    expect(dispatch).toHaveBeenCalledWith({
      type: 'library/songsUpdated',
      songs: [expect.objectContaining({ id: 'a', durationSec: 184 })]
    })
  })

  it('writes many measured songs in one batch, not one write each', async () => {
    const three = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
    const api = seedApi({ songs: three })
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill(three, dispatch, true))

    await waitFor(() => expect(probes).toHaveLength(2))
    await reportDuration(probes[0], 173)
    await reportDuration(probes[1], 41)
    await waitFor(() => expect(probes).toHaveLength(3))
    await reportDuration(probes[2], 12)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 },
      { id: 'b', durationSec: 41 },
      { id: 'c', durationSec: 12 }
    ])
    // One dispatch behind the batch: the list re-renders once for three songs, not once each.
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  /** A file under half a second rounds to 0, which the library refuses — along with its batch. */
  it('leaves behind a probe too short to round to a second rather than losing the batch', async () => {
    const three = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
    const api = seedApi({ songs: three })
    backfill(three)

    await waitFor(() => expect(probes).toHaveLength(2))
    await reportDuration(probes[0], 173)
    await reportDuration(probes[1], 0.4)
    await waitFor(() => expect(probes).toHaveLength(3))
    await reportDuration(probes[2], 12)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 },
      { id: 'c', durationSec: 12 }
    ])
  })

  it('flushes a full batch early rather than holding every measurement to the end', async () => {
    const nine = Array.from({ length: 9 }, (_, index) => song(`s${index}`, `Song ${index}`))
    const api = seedApi({ songs: nine })
    backfill(nine)

    // Answered one at a time, so the readers hand back measurements in song order.
    for (let index = 0; index < nine.length; index++) {
      await waitFor(() => expect(probes.length).toBeGreaterThan(index))
      await reportDuration(probes[index], 100 + index)
    }

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(2))
    const [first, second] = vi.mocked(api.library.updateDurations).mock.calls
    expect(first[0].map((entry) => entry.id)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7'
    ])
    expect(second[0]).toEqual([{ id: 's8', durationSec: 108 }])
  })

  /** StrictMode really double-mounts this hook: main.tsx wraps the app in it. */
  it('survives a mount, unmount, remount without losing or doubling a measurement', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const first = backfill([song('a', 'Alpha Mix')])

    await waitFor(() => expect(probes).toHaveLength(1))
    first.unmount()
    backfill([song('a', 'Alpha Mix')])

    await waitFor(() => expect(probes).toHaveLength(2))
    await reportDuration(probes[1], 173)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 }
    ])
  })

  /** Two `renderHook` calls each get their own refs; only a StrictMode wrapper shares them. */
  it('re-asks a song StrictMode cut the probe short on, and writes it once', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill([song('a', 'Alpha Mix')], dispatch, true), {
      wrapper: StrictMode
    })

    await waitFor(() => expect(probes).toHaveLength(2))
    await reportDuration(probes[1], 173)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 }
    ])
  })

  it('has nothing to measure on a song that is already timed or whose file is gone', async () => {
    const api = seedApi()
    const { rerender } = backfill([
      song('a', 'Alpha Mix', { durationSec: 100 }),
      song('b', 'Bravo Beat', { exists: false, sizeBytes: null })
    ])

    rerender({ list: [song('a', 'Alpha Mix', { durationSec: 100 })], idle: true })
    await act(async () => {})

    expect(probes).toHaveLength(0)
    expect(api.library.updateDurations).not.toHaveBeenCalled()
  })

  it('leaves a file it could not read alone rather than asking it again', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const songs = [song('a', 'Alpha Mix')]
    const { rerender } = backfill(songs)

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportFailure(probes[0])

    // Same song, fresh array: the render that follows must not start the probe over.
    rerender({ list: [song('a', 'Alpha Mix')], idle: true })
    await act(async () => {})

    expect(probes).toHaveLength(1)
    expect(api.library.updateDurations).not.toHaveBeenCalled()
  })

  it('ignores a duration the file reports as nonsense', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    backfill([song('a', 'Alpha Mix')])

    await waitFor(() => expect(probes).toHaveLength(1))
    // A stream of unknown length reports Infinity; 0 is a file with nothing in it.
    await reportDuration(probes[0], Number.POSITIVE_INFINITY)
    await act(async () => {})

    expect(api.library.updateDurations).not.toHaveBeenCalled()
  })

  it('reads two files at a time and takes the next one as each finishes', async () => {
    seedApi({
      songs: [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
    })
    backfill([song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')])

    await waitFor(() => expect(probes).toHaveLength(2))
    await act(async () => {})
    // The third waits its turn rather than opening a file per song at once.
    expect(probes).toHaveLength(2)

    await reportDuration(probes[0], 60)

    await waitFor(() => expect(probes).toHaveLength(3))
  })

  /** Probes share the `media://` fetch pool with the playing song, which has first claim. */
  it('starts no probe while something is playing and picks the queue up when it stops', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const songs = [song('a', 'Alpha Mix')]
    const { rerender } = backfill(songs, false)

    await act(async () => {})
    expect(probes).toHaveLength(0)

    rerender({ list: songs, idle: true })

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportDuration(probes[0], 173)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 }
    ])
  })

  it('lets the read in flight finish but starts no new one once playback begins', async () => {
    const three = [song('a', 'Alpha Mix'), song('b', 'Bravo Beat'), song('c', 'Charlie Tune')]
    const api = seedApi({ songs: three })
    const { rerender } = backfill(three)

    await waitFor(() => expect(probes).toHaveLength(2))
    rerender({ list: three, idle: false })

    // The reader that owned this one hands its measurement in and stops; Charlie stays queued.
    await reportDuration(probes[0], 173)
    await act(async () => {})
    expect(probes).toHaveLength(2)

    rerender({ list: three, idle: true })

    await waitFor(() => expect(probes).toHaveLength(3))
    await reportDuration(probes[1], 41)
    await reportDuration(probes[2], 12)

    await waitFor(() => expect(vi.mocked(api.library.updateDurations)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.library.updateDurations).mock.calls[0][0]).toEqual([
      { id: 'a', durationSec: 173 },
      { id: 'b', durationSec: 41 },
      { id: 'c', durationSec: 12 }
    ])
  })

  it('says nothing when the library refuses the measurement', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    vi.mocked(api.library.updateDurations).mockRejectedValue(new Error('library.json is read-only'))
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill([song('a', 'Alpha Mix')], dispatch, true))

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportDuration(probes[0], 120)
    await act(async () => {})

    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('duration backfill in the app', () => {
  it('fills in the playing time the rows are showing a placeholder for', async () => {
    seedApi({ songs: [song('a', 'Alpha Mix')] })
    await renderApp()
    expect(screen.getByText('–:––')).toBeInTheDocument()

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportDuration(probes[0], 173)

    expect(await screen.findByText('2:53')).toBeInTheDocument()
  })
})
