import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMediaSession, type MediaSessionOptions } from './useMediaSession'

/** What the fake session captures; `handlers` maps action name → latest handler (or null). */
function fakeSession() {
  const handlers = new Map<string, (() => void) | null>()
  return {
    metadata: null as unknown,
    playbackState: 'none' as string,
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      handlers.set(action, handler)
    }),
    handlers
  }
}

class FakeMediaMetadata {
  title: string
  constructor(init: { title: string }) {
    this.title = init.title
  }
}

let session: ReturnType<typeof fakeSession>

beforeEach(() => {
  session = fakeSession()
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
  vi.stubGlobal('MediaMetadata', FakeMediaMetadata)
})

afterEach(() => {
  // @ts-expect-error test-installed property
  delete navigator.mediaSession
  vi.unstubAllGlobals()
})

function Harness(props: MediaSessionOptions): null {
  useMediaSession(props)
  return null
}

const noop = (): void => undefined
const base: MediaSessionOptions = {
  title: 'Song A',
  isPlaying: true,
  onPlay: noop,
  onPause: noop,
  onNext: noop,
  onPrev: noop
}

describe('useMediaSession', () => {
  it('publishes metadata and playing state for the cued song', () => {
    render(<Harness {...base} />)
    expect((session.metadata as FakeMediaMetadata).title).toBe('Song A')
    expect(session.playbackState).toBe('playing')
  })

  it('reports paused without dropping the metadata', () => {
    render(<Harness {...base} isPlaying={false} />)
    expect((session.metadata as FakeMediaMetadata).title).toBe('Song A')
    expect(session.playbackState).toBe('paused')
  })

  it('routes the four remote commands to the given callbacks', () => {
    const onPlay = vi.fn()
    const onPause = vi.fn()
    const onNext = vi.fn()
    const onPrev = vi.fn()
    render(<Harness {...base} onPlay={onPlay} onPause={onPause} onNext={onNext} onPrev={onPrev} />)
    session.handlers.get('play')?.()
    session.handlers.get('pause')?.()
    session.handlers.get('nexttrack')?.()
    session.handlers.get('previoustrack')?.()
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('clears everything when nothing is cued', () => {
    const { rerender } = render(<Harness {...base} />)
    rerender(<Harness {...base} title={null} />)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
      expect(session.handlers.get(action)).toBeNull()
    }
  })

  it('clears the handlers on unmount', () => {
    const { unmount } = render(<Harness {...base} />)
    unmount()
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
      expect(session.handlers.get(action)).toBeNull()
    }
  })

  it('is a no-op where the browser has no media session', () => {
    // @ts-expect-error test-installed property
    delete navigator.mediaSession
    expect(() => render(<Harness {...base} />)).not.toThrow()
  })
})
