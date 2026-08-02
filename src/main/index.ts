import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC_EVENTS, MEDIA_SCHEME } from '../shared/ipc'
import type { AppError } from '../shared/types'
import { createDownloader } from './ingest/downloader'
import { resolveFfmpegPath, transcode } from './ingest/ffmpeg'
import { importFile, type ImportDeps, type ImportRequest } from './ingest/importer'
import { runLines } from './ingest/spawnLines'
import { download, probe, resolveYtDlpPath, updateYtDlp } from './ingest/ytdlp'
import { registerIngestIpc } from './ipc/registerIngestIpc'
import { registerLibraryIpc } from './ipc/registerLibraryIpc'
import { createMediaHandler } from './media/mediaProtocol'
import { audioDir, ensureDirs, resolveLibraryRoot } from './paths'
import { createLibraryStore } from './store/libraryStore'
import { createPlaylistStore } from './store/playlistStore'
import { createSettingsStore } from './store/settingsStore'
import {
  createWindowSender,
  fileExists,
  resolveResourcesBinDir,
  runStartup,
  withErrorReport
} from './wiring'

/**
 * Must run before `app.whenReady()`: the renderer streams audio from `media://audio/<id>` and the
 * scheme needs standard/secure/stream/fetch privileges for `<audio>` and Range requests to work.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

/** The one window, tracked so the push channels can find it (or find that it is gone). */
let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs `webUtils.getPathForFile`, which is unavailable in a sandboxed preload.
      sandbox: false
    }
  })
  mainWindow = window

  window.on('ready-to-show', () => {
    window.show()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Local-only app: never open new windows, never navigate away from the bundled renderer.
  // Reloading the current URL stays allowed — cancelling it would also kill vite's HMR
  // `full-reload`, which is implemented as `location.reload()`.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * Composition, and nothing else — every decision in here lives in `wiring.ts` or in a module with
 * its own tests. It runs inside `runStartup`, so a failure on the way to the first window (a
 * read-only library root, a bad `MML_LIBRARY_DIR`, no ffmpeg for this platform) is shown rather
 * than lost as an unhandled rejection.
 */
function startup(): void {
  electronApp.setAppUserModelId('com.duolume.mymusiclibrary')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const libraryRoot = resolveLibraryRoot()
  ensureDirs(libraryRoot)
  const audio = audioDir(libraryRoot)

  // ONE instance of each store for the whole process. Every store keeps a lifetime in-memory copy
  // of its file and never re-reads it, so a second instance over the same directory would serve
  // stale data and overwrite the first one's writes.
  const libraryStore = createLibraryStore(libraryRoot)
  const playlistStore = createPlaylistStore(libraryRoot)
  const settingsStore = createSettingsStore(libraryRoot)

  const sendToWindow = createWindowSender(() => mainWindow)
  const reportError = (error: AppError): void => sendToWindow(IPC_EVENTS.error, error)

  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({ getSong: (id) => libraryStore.getSong(id), audioDir: audio })
  )

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStaticPath = require('ffmpeg-static') as string | null
  const ffmpegPath = resolveFfmpegPath({ ffmpegStaticPath, isPackaged: app.isPackaged })
  // Both ways into the library — the picker/drop handler and the downloader — import through the
  // same deps, and therefore through the same `libraryStore` instance.
  const importDeps: ImportDeps = {
    audioDir: audio,
    libraryStore,
    transcode: ({ src, dst }) => transcode({ src, dst, ffmpegPath })
  }
  const importSong = withErrorReport('import', reportError, (request: ImportRequest) =>
    importFile(request, importDeps)
  )

  registerLibraryIpc(ipcMain, {
    libraryStore,
    playlistStore,
    settingsStore,
    audioDir: audio,
    // The importer records the song itself, so the handler must not add it a second time.
    importSong,
    trashItem: withErrorReport('trash', reportError, (absPath: string) => shell.trashItem(absPath)),
    fileExists,
    revealInFolder: (absPath) => shell.showItemInFolder(absPath)
  })

  const userDataBinDir = path.join(app.getPath('userData'), 'bin')
  const resourcesBinDir = resolveResourcesBinDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
    platform: process.platform
  })
  // Resolved per call: a self-update lands a newer copy in userData that must win from then on.
  const ytDlpPath = (): string =>
    resolveYtDlpPath({
      userDataBinDir,
      resourcesBinDir,
      platform: process.platform,
      exists: existsSync
    })
  /** The shipped copy, whatever the platform names it — never the self-updated one. */
  const bundledYtDlpPath = (): string =>
    resolveYtDlpPath({
      userDataBinDir,
      resourcesBinDir,
      platform: process.platform,
      exists: () => false
    })

  const downloader = createDownloader({
    tempDir: app.getPath('temp'),
    importFile: (request) => importFile(request, importDeps),
    download: (job) =>
      download({
        url: job.url,
        outTemplate: job.outTemplate,
        ffmpegDir: path.dirname(ffmpegPath),
        run: runLines,
        binPath: ytDlpPath(),
        ...(job.onProgress ? { onProgress: job.onProgress } : {}),
        signal: job.signal
      }),
    probe: (url) => probe({ url, run: runLines, binPath: ytDlpPath() })
  })

  // The returned unsubscribe is dropped on purpose: the progress subscription lives as long as
  // the process does, and `sendToWindow` already copes with the window coming and going.
  registerIngestIpc(ipcMain, {
    // Spread rather than mutated: the downloader's methods close over its own state, so a copy
    // with a reporting `start` drives exactly the same download.
    downloader: {
      ...downloader,
      start: withErrorReport('ytdlp', reportError, (request) => downloader.start(request))
    },
    updateYtDlp: () =>
      updateYtDlp({ userDataBinDir, bundledPath: bundledYtDlpPath(), run: runLines }),
    pickAudioFiles: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Add songs',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Audio',
            extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'aiff', 'wma']
          },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      return result.canceled ? [] : result.filePaths
    },
    sendProgress: sendToWindow
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

void app.whenReady().then(() =>
  runStartup(startup, {
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
    quit: () => app.quit()
  })
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
