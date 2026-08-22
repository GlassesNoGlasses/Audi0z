import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LibraryFile, PlaylistsFile, Song } from '../../src/shared/types'
import { makeWav } from '../support/makeWav'

/** Built main process, real `media://`, real files; each test gets its own `AUDI0Z_LIBRARY_DIR`. */

/** Long enough that a seek to the middle still has seconds of audio left to play. */
const CLIP_SECONDS = 30

interface Fixture {
  root: string
  audio: string
}

const SEEDED_SONGS: Song[] = [
  {
    id: 'song-alpha',
    fileName: 'song-alpha.wav',
    title: 'Alpha Mix',
    tags: ['slowed'],
    addedAt: '2024-01-01T00:00:00.000Z',
    compressed: false
  },
  {
    id: 'song-bravo',
    fileName: 'song-bravo.wav',
    title: 'Bravo Beat',
    tags: [],
    addedAt: '2024-01-02T00:00:00.000Z',
    compressed: false
  }
]

async function seedLibrary(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mml-e2e-'))
  const audio = path.join(root, 'audio')
  await mkdir(audio, { recursive: true })

  const clip = makeWav(CLIP_SECONDS)
  for (const song of SEEDED_SONGS) {
    await writeFile(path.join(audio, song.fileName), clip)
  }

  const library: LibraryFile = { version: 1, songs: SEEDED_SONGS }
  const playlists: PlaylistsFile = { version: 1, playlists: [] }
  await writeFile(path.join(root, 'library.json'), JSON.stringify(library))
  await writeFile(path.join(root, 'playlists.json'), JSON.stringify(playlists))

  return { root, audio }
}

/** Type-checked with the main process, which has no DOM lib, so the one global is declared here. */
declare const document: {
  querySelector(selector: 'audio'): {
    paused: boolean
    readyState: number
    currentTime: number
  } | null
}

function audioState(page: Page): Promise<{ paused: boolean; readyState: number; time: number }> {
  return page.evaluate(() => {
    const audio = document.querySelector('audio')
    if (!audio) return { paused: true, readyState: -1, time: -1 }
    return { paused: audio.paused, readyState: audio.readyState, time: audio.currentTime }
  })
}

let app: ElectronApplication
let page: Page
let fixture: Fixture

test.beforeEach(async () => {
  fixture = await seedLibrary()
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...(process.env as Record<string, string>), AUDI0Z_LIBRARY_DIR: fixture.root }
  })
  page = await app.firstWindow()
  await page.waitForSelector('.app')
})

test.afterEach(async () => {
  await app.close()
  await rm(fixture.root, { recursive: true, force: true })
})

test('opens the window and lists the library from disk', async () => {
  await expect(page.getByRole('button', { name: 'Alpha Mix', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bravo Beat', exact: true })).toBeVisible()

  // MM/DD/YYYY only by shape — the literal day depends on the machine's timezone.
  await expect(page.locator('.song-list .song-added')).toHaveText([
    /^\d{2}\/\d{2}\/\d{4}$/,
    /^\d{2}\/\d{2}\/\d{4}$/
  ])
})

test('plays a song over the media:// protocol', async () => {
  const alpha = page.getByRole('button', { name: 'Alpha Mix', exact: true })
  await expect(alpha).toBeVisible()

  // The clock starts on the click, not on launch.
  const before = Date.now()
  await alpha.click()

  await expect
    .poll(async () => (await audioState(page)).time, { intervals: [50] })
    .toBeGreaterThan(0)
  // Latency-sensitive: a song in a quiet library must start well under a second.
  expect(Date.now() - before).toBeLessThan(1200)

  const state = await audioState(page)
  expect(state.readyState).toBeGreaterThanOrEqual(2)
  expect(state.paused).toBe(false)
})

test('seeks into the middle of a song', async () => {
  await page.getByRole('button', { name: 'Alpha Mix', exact: true }).click()
  const seek = page.getByRole('slider', { name: 'Seek' })
  await expect(seek).toBeEnabled()

  await seek.fill('15')

  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(15)
})

test('filters the list from the search box', async () => {
  await page.getByRole('searchbox', { name: 'Search songs', exact: true }).fill('bravo')
  await expect(page.locator('.song-list .song-title')).toHaveText(['Bravo Beat'])
})

test('creates a playlist that lands in playlists.json', async () => {
  await page.getByRole('button', { name: 'New playlist' }).click()
  await page.getByRole('textbox', { name: 'New playlist name' }).fill('Late night')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect
    .poll(async () => {
      const raw = await readFile(path.join(fixture.root, 'playlists.json'), 'utf8')
      return (JSON.parse(raw) as PlaylistsFile).playlists.map((playlist) => playlist.name)
    })
    .toEqual(['Late night'])
})

/** Only provable here: jsdom has no box model. */
test('keeps the new playlist button on the bottom edge of the sidebar', async () => {
  const sidebar = await page.locator('.sidebar').boundingBox()
  const list = await page.locator('.playlist-list').boundingBox()
  const create = await page.getByRole('button', { name: 'New playlist' }).boundingBox()
  // `exact`, or the top bar's "Play Library" is a second match.
  const library = await page.getByRole('button', { name: 'Library', exact: true }).boundingBox()
  if (!sidebar || !list || !create || !library) throw new Error('the sidebar rendered no boxes')

  // The lower bound catches a footer pushed off: a negative gap hangs below the panel.
  const gapBelowCreate = sidebar.y + sidebar.height - (create.y + create.height)
  expect(gapBelowCreate).toBeLessThan(30)
  expect(gapBelowCreate).toBeGreaterThanOrEqual(0)
  expect(create.y).toBeGreaterThanOrEqual(list.y + list.height)
  // A row rather than a panel: an entry that grows would swallow the space above the list.
  expect(library.height).toBeLessThan(40)
})

/** Only provable here: the times come off real decoded audio, and jsdom has no decoder. */
test('measures the playing times of the library and keeps them', async () => {
  await expect(page.locator('.song-list .song-duration')).toHaveText([
    `0:${CLIP_SECONDS}`,
    `0:${CLIP_SECONDS}`
  ])

  await expect
    .poll(async () => {
      const raw = await readFile(path.join(fixture.root, 'library.json'), 'utf8')
      return (JSON.parse(raw) as LibraryFile).songs.map((song) => song.durationSec)
    })
    .toEqual([CLIP_SECONDS, CLIP_SECONDS])
})

test('adds a song to a playlist from the add-to-playlist dialog', async () => {
  await page.getByRole('button', { name: 'New playlist' }).click()
  await page.getByRole('textbox', { name: 'New playlist name' }).fill('Late night')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // Viewing the playlist is what puts its own add button on the bar, beside the library's.
  await page.getByRole('button', { name: 'Late night', exact: true }).click()
  await page.getByRole('button', { name: 'Add songs to Late night', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Add to Late night' })
  await dialog.getByRole('searchbox', { name: 'Search songs to add' }).fill('alpha')
  await dialog.getByRole('button', { name: 'Add Alpha Mix to Late night' }).click()

  await expect(dialog.getByRole('button', { name: 'Add Alpha Mix to Late night' })).toHaveCount(0)
  await expect
    .poll(async () => {
      const raw = await readFile(path.join(fixture.root, 'playlists.json'), 'utf8')
      return (JSON.parse(raw) as PlaylistsFile).playlists[0]?.songIds
    })
    .toEqual(['song-alpha'])
})

test('adds a song chosen from the file picker', async () => {
  const incoming = path.join(fixture.root, 'incoming')
  await mkdir(incoming, { recursive: true })
  const sourcePath = path.join(incoming, 'Fixture Song.wav')
  await writeFile(sourcePath, makeWav(1))

  await app.evaluate(({ dialog }, filePath) => {
    const stub = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
      canceled: false,
      filePaths: [filePath]
    })
    ;(dialog as unknown as { showOpenDialog: typeof stub }).showOpenDialog = stub
  }, sourcePath)

  await page.getByRole('button', { name: 'Add song', exact: true }).click()
  await page.getByRole('button', { name: 'Add Files Here…' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Fixture Song')
  await page.getByRole('button', { name: 'Add to library' }).click()

  await expect(page.getByRole('button', { name: 'Fixture Song', exact: true })).toBeVisible()

  const raw = await readFile(path.join(fixture.root, 'library.json'), 'utf8')
  const added = (JSON.parse(raw) as LibraryFile).songs.find((song) => song.title === 'Fixture Song')
  expect(added).toBeDefined()
  await expect(stat(path.join(fixture.audio, added!.fileName))).resolves.toBeDefined()
})
