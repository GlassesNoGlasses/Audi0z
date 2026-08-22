import { act, render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import {
  createMockApi,
  DEFAULT_MOCK_SIZE_BYTES,
  type MockApiSeed
} from '../../../../tests/support/mockApi'
import type { Api } from '../../../shared/api'
import type { Playlist, SongDto } from '../../../shared/types'
import { App } from '../App'

/** Renderer-test scaffolding: a seeded `window.api`, a jsdom-safe `<audio>`, markup readers. */

/** Installs a fresh mock api on `window` and returns it (replacing the setup file's default). */
export function seedApi(seed: MockApiSeed = {}): Api {
  const api = createMockApi(seed)
  ;(globalThis as unknown as { api: Api }).api = api
  return api
}

/** Stubs jsdom's absent media pipeline (play/pause plus a tracking `paused`). Call at top level. */
export function stubMediaElement(): void {
  beforeEach(() => {
    const paused = new WeakMap<HTMLMediaElement, boolean>()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
      this: HTMLMediaElement
    ) {
      paused.set(this, false)
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
      this: HTMLMediaElement
    ) {
      paused.set(this, true)
    })
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (
      this: HTMLMediaElement
    ) {
      return paused.get(this) ?? true
    })
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

export function audioElement(): HTMLAudioElement {
  const audio = document.querySelector('audio')
  if (!audio) throw new Error('harness: the app rendered no <audio> element')
  return audio
}

export function sidebar(): HTMLElement {
  return screen.getByRole('complementary')
}

/** Chooses a sort mode; the menu closes behind each choice, so a descending sort is two presses. */
export async function sortView(
  user: ReturnType<typeof userEvent.setup>,
  item: string | RegExp,
  presses = 1
): Promise<void> {
  for (let press = 0; press < presses; press += 1) {
    await user.click(screen.getByRole('button', { name: 'Sort songs' }))
    await user.click(screen.getByRole('menuitemradio', { name: item }))
  }
}

/** Titles currently listed in the main song list, in display order. */
export function songTitles(): string[] {
  return [...document.querySelectorAll('.song-list .song-title')].map((el) => el.textContent ?? '')
}

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
  // DTO invariant, applied after the override: `sizeBytes` is null exactly when `exists` is false.
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
