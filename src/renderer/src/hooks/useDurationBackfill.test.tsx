import { act, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SongDto } from '../../../shared/types'
import { renderApp, seedApi, song, stubDuration, stubMediaElement } from '../testing/harness'
import { useDurationBackfill } from './useDurationBackfill'

stubMediaElement()

/**
 * jsdom has no media pipeline, so a probe never resolves on its own: the tests below stand in for
 * the browser by defining `duration` on the element the hook created and firing the event it is
 * waiting for. Only elements built with `new Audio()` are captured — the app's own JSX `<audio>`
 * is not one of them.
 */
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

function backfill(songs: SongDto[]): ReturnType<typeof renderHook<void, { list: SongDto[] }>> {
  const dispatch = vi.fn()
  return renderHook(({ list }: { list: SongDto[] }) => useDurationBackfill(list, dispatch), {
    initialProps: { list: songs }
  })
}

describe('useDurationBackfill', () => {
  it('measures a song that has no playing time yet and writes the whole seconds back', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill([song('a', 'Alpha Mix')], dispatch))

    await waitFor(() => expect(probes).toHaveLength(1))
    expect(probes[0].getAttribute('preload')).toBe('metadata')
    expect(probes[0].getAttribute('src')).toBe('media://audio/a')

    await reportDuration(probes[0], 183.6)

    await waitFor(() => expect(api.library.update).toHaveBeenCalledWith('a', { durationSec: 184 }))
    expect(dispatch).toHaveBeenCalledWith({
      type: 'library/songUpdated',
      song: expect.objectContaining({ id: 'a', durationSec: 184 })
    })
  })

  it('has nothing to measure on a song that is already timed or whose file is gone', async () => {
    const api = seedApi()
    const { rerender } = backfill([
      song('a', 'Alpha Mix', { durationSec: 100 }),
      song('b', 'Bravo Beat', { exists: false, sizeBytes: null })
    ])

    // A re-render is a fair chance to have started one; nothing does.
    rerender({ list: [song('a', 'Alpha Mix', { durationSec: 100 })] })
    await act(async () => {})

    expect(probes).toHaveLength(0)
    expect(api.library.update).not.toHaveBeenCalled()
  })

  it('leaves a file it could not read alone rather than asking it again', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    const songs = [song('a', 'Alpha Mix')]
    const { rerender } = backfill(songs)

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportFailure(probes[0])

    // Same song, fresh array: the render that follows must not start the probe over.
    rerender({ list: [song('a', 'Alpha Mix')] })
    await act(async () => {})

    expect(probes).toHaveLength(1)
    expect(api.library.update).not.toHaveBeenCalled()
  })

  it('ignores a duration the file reports as nonsense', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    backfill([song('a', 'Alpha Mix')])

    await waitFor(() => expect(probes).toHaveLength(1))
    // A stream of unknown length reports Infinity; 0 is a file with nothing in it.
    await reportDuration(probes[0], Number.POSITIVE_INFINITY)
    await act(async () => {})

    expect(api.library.update).not.toHaveBeenCalled()
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

  it('says nothing when the library refuses the measurement', async () => {
    const api = seedApi({ songs: [song('a', 'Alpha Mix')] })
    vi.mocked(api.library.update).mockRejectedValue(new Error('library.json is read-only'))
    const dispatch = vi.fn()
    renderHook(() => useDurationBackfill([song('a', 'Alpha Mix')], dispatch))

    await waitFor(() => expect(probes).toHaveLength(1))
    await reportDuration(probes[0], 120)
    await act(async () => {})

    // Background enrichment nobody asked for: it fails quietly.
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
