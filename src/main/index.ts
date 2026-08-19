import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import path from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC_EVENTS, MEDIA_SCHEME } from '../shared/ipc'
import type { AppError } from '../shared/types'
import { compressExisting } from './ingest/compressExisting'
import { createCompressionJobs } from './ingest/compressionJobs'
import { createDownloader } from './ingest/downloader'
import { resolveFfmpegPath, transcode } from './ingest/ffmpeg'
import { importFile, type ImportDeps, type ImportRequest } from './ingest/importer'
import { runLines } from './ingest/spawnLines'
import { download, probe, removeSelfUpdatedYtDlp, resolveYtDlpPath } from './ingest/ytdlp'
import { registerIngestIpc } from './ipc/registerIngestIpc'
import { registerLibraryIpc } from './ipc/registerLibraryIpc'
import { createMediaHandler } from './media/mediaProtocol'
import { AUDIO_FILE_FILTERS } from './media/mimeTypes'
import { audioDir, ensureDirs, resolveLibraryRoot } from './paths'
import { createLibraryStore } from './store/libraryStore'
import { createPlaylistStore } from './store/playlistStore'
import { createSettingsStore } from './store/settingsStore'
import { createTagStore } from './store/tagStore'
import {
  createWindowSender,
  fileExists,
  fileSize,
  resolveResourcesBinDir,
  runStartup,
  withErrorReport
} from './wiring'

/**
 * Custom protocol for renderer to stream audio from `media://audio/<id>`.
 * Required for Chromium <audio> stream fetch requests + security.
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

// the window; left out for channel push requests
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

  // local-app only; don't allow opening/navigating outside
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

function startup(): void {
  electronApp.setAppUserModelId('com.gng.audi0z')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // set-up paths + in-memory stores
  const libraryRoot = resolveLibraryRoot()
  ensureDirs(libraryRoot)
  const audio = audioDir(libraryRoot)

  const libraryStore = createLibraryStore(libraryRoot)
  const playlistStore = createPlaylistStore(libraryRoot)
  const settingsStore = createSettingsStore(libraryRoot)
  const tagStore = createTagStore(libraryRoot)

  const sendToWindow = createWindowSender(() => mainWindow) // window channel
  const reportError = (error: AppError): void => sendToWindow(IPC_EVENTS.error, error)

  // song compression write jobs
  const compressionJobs = createCompressionJobs()

  // register `media://*` scheme
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      getSong: (id) => libraryStore.getSong(id),
      audioDir: audio,
      awaitCompression: (id) => compressionJobs.waitFor(id)
    })
  )

  // ffmpeg binary check
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStaticPath = require('ffmpeg-static') as string | null
  const ffmpegPath = resolveFfmpegPath({ ffmpegStaticPath, isPackaged: app.isPackaged })

  const importDeps: ImportDeps = {
    audioDir: audio,
    libraryStore,
    transcode: ({ src, dst }) => transcode({ src, dst, ffmpegPath })
  }

  // error wrapping
  const importSong = withErrorReport('import', reportError, (request: ImportRequest) =>
    importFile(request, importDeps)
  )
  const compressSong = withErrorReport('ffmpeg', reportError, (id: string) =>
    compressionJobs.run(id, () =>
      compressExisting(id, {
        audioDir: audio,
        libraryStore,
        transcode: ({ src, dst }) => transcode({ src, dst, ffmpegPath })
      })
    )
  )

  registerLibraryIpc(ipcMain, {
    libraryStore,
    playlistStore,
    settingsStore,
    tagStore,
    audioDir: audio,
    importSong,
    compressSong,
    awaitCompression: (id) => compressionJobs.waitFor(id),
    trashItem: withErrorReport('trash', reportError, (absPath: string) => shell.trashItem(absPath)),
    fileExists,
    fileSize,
    revealInFolder: (absPath) => shell.showItemInFolder(absPath)
  })

  const userDataBinDir = path.join(app.getPath('userData'), 'bin')
  const resourcesBinDir = resolveResourcesBinDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
    platform: process.platform
  })

  const ytDlpPath = resolveYtDlpPath({
    resourcesBinDir,
    platform: process.platform
  })
  // remove older versions of yt-delp
  void removeSelfUpdatedYtDlp({ userDataBinDir, platform: process.platform })

  const downloader = createDownloader({
    tempDir: app.getPath('temp'),
    importFile: (request) => importFile(request, importDeps),
    download: (job) =>
      download({
        url: job.url,
        outTemplate: job.outTemplate,
        ffmpegDir: path.dirname(ffmpegPath),
        run: runLines,
        binPath: ytDlpPath,
        // The app's own binary, run as Node, is yt-dlp's JS runtime — see ytdlp.ts.
        jsRuntimePath: process.execPath,
        ...(job.onProgress ? { onProgress: job.onProgress } : {}),
        signal: job.signal
      }),
    probe: (url) =>
      probe({ url, run: runLines, binPath: ytDlpPath, jsRuntimePath: process.execPath })
  })

  app.on('before-quit', () => {
    downloader.cancel()
  })

  registerIngestIpc(ipcMain, {
    downloader: {
      ...downloader,
      start: withErrorReport('ytdlp', reportError, (request) => downloader.start(request))
    },
    pickAudioFiles: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Add songs',
        properties: ['openFile', 'multiSelections'],
        filters: [...AUDIO_FILE_FILTERS]
      })
      return result.canceled ? [] : result.filePaths
    },
    sendProgress: sendToWindow,
    audioDir: audio,
    fileSize
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
