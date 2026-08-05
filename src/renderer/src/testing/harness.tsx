import { act, render, screen, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import {
  createMockApi,
  DEFAULT_MOCK_SIZE_BYTES,
  type MockApiSeed
} from '../../../../tests/support/mockApi'
import type { Api } from '../../../shared/api'
import type { Playlist, SongDto } from '../../../shared/types'
import { App } from '../App'

/**
 * Shared scaffolding for the renderer tests: a seeded `window.api`, a jsdom-safe `<audio>`, and
 * readers for the few bits of markup the tests care about.
 *
 * It lives under `src/renderer` rather than in `tests/support` because it renders the app — a JSX
 * module belongs to the web typecheck program, and `tests/support` is shared with the node one.
 */

/** Installs a fresh mock api on `window` and returns it (replacing the setup file's default). */
export function seedApi(seed: MockApiSeed = {}): Api {
  const api = createMockApi(seed)
  ;(globalThis as unknown as { api: Api }).api = api
  return api
}

/**
 * jsdom implements no media pipeline: `play()`/`pause()` are `notImplemented` stubs that print to
 * the console. Call at the top level of any test file whose UI reaches the `<audio>` element.
 */
export function stubMediaElement(): void {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
}

/** The `play()` spy installed by `stubMediaElement()`. */
export function playSpy(): Mock {
  return HTMLMediaElement.prototype.play as unknown as Mock
}

/** jsdom leaves `duration` at NaN forever; a range slider needs a real one to clamp against. */
export function stubDuration(audio: HTMLAudioElement, seconds: number): void {
  Object.defineProperty(audio, 'duration', { value: seconds, configurable: true })
}

/** Renders the app and lets its start-up loads settle, so tests never assert on a blank shell. */
export async function renderApp(): Promise<RenderResult> {
  let result: RenderResult | undefined
  await act(async () => {
    result = render(<App />)
  })
  if (!result) throw new Error('harness: render produced nothing')
  return result
}

/** The single `<audio>` element the app renders. */
export function audioElement(): HTMLAudioElement {
  const audio = document.querySelector('audio')
  if (!audio) throw new Error('harness: the app rendered no <audio> element')
  return audio
}

/** The element drag-and-drop is wired to. */
export function appRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.app')
  if (!root) throw new Error('harness: the app rendered no root element')
  return root
}

export function sidebar(): HTMLElement {
  return screen.getByRole('complementary')
}

/** Titles currently listed in the main song list, in display order. */
export function songTitles(): string[] {
  return [...document.querySelectorAll('.song-list .song-title')].map((el) => el.textContent ?? '')
}

/** What the player bar says is playing. */
export function nowPlaying(): string {
  return document.querySelector('.player-title')?.textContent ?? ''
}

export function song(id: string, title: string, extra: Partial<SongDto> = {}): SongDto {
  const dto: SongDto = {
    id,
    fileName: `${id}.wav`,
    title,
    tags: [],
    addedAt: '2024-01-01T00:00:00.000Z',
    compressed: false,
    exists: true,
    url: `media://audio/${id}`,
    sizeBytes: DEFAULT_MOCK_SIZE_BYTES,
    ...extra
  }
  // The DTO invariant, applied after the override: `sizeBytes` is null exactly when `exists` is
  // false, so `{ exists: false }` on its own gets the null rather than the default weight.
  return dto.exists ? dto : { ...dto, sizeBytes: null }
}

export function playlist(
  id: string,
  name: string,
  songIds: string[],
  extra: Partial<Playlist> = {}
): Playlist {
  return {
    id,
    name,
    songIds,
    shuffle: false,
    repeat: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...extra
  }
}
