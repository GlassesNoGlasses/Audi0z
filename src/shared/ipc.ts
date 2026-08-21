/**
 * Main IPC structure for app `API` wiring.
 *
 * Parts:
 * - library: main to interact with audio files.
 * - tags: tags and cascading edits.
 * - playlists: playlist + playlist settings (shuffle, repeat).
 * - files: fs `audi0z` path to audio file.
 * - download: main downloader.
 * - settings: settings & user prefs.
 */

/** Request/response channels — `ipcRenderer.invoke` / `ipcMain.handle`. */
export const IPC = {
  library: {
    list: 'library:list',
    add: 'library:add',
    update: 'library:update',
    updateDurations: 'library:updateDurations',
    remove: 'library:remove',
    reorder: 'library:reorder',
    compress: 'library:compress',
    showFolder: 'library:showFolder'
  },
  tags: {
    list: 'tags:list',
    create: 'tags:create',
    rename: 'tags:rename',
    remove: 'tags:remove'
  },
  playlists: {
    list: 'playlists:list',
    create: 'playlists:create',
    remove: 'playlists:remove',
    rename: 'playlists:rename',
    reorder: 'playlists:reorder',
    addSong: 'playlists:addSong',
    removeSong: 'playlists:removeSong',
    setPlaybackOptions: 'playlists:setPlaybackOptions',
    reorderSongs: 'playlists:reorderSongs'
  },
  files: {
    pickAudioFiles: 'files:pickAudioFiles'
  },
  download: {
    probe: 'download:probe',
    start: 'download:start',
    cancel: 'download:cancel'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  }
} as const

// IPC subscription events
export const IPC_EVENTS = {
  downloadProgress: 'event:downloadProgress',
  libraryChanged: 'event:libraryChanged',
  error: 'event:error'
} as const

// App scheme `media://audio/<id>`
export const MEDIA_SCHEME = 'media'
