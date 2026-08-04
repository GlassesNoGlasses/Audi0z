/**
 * IPC channel names. One constant per `Api` method that crosses the process boundary, so the
 * preload and the main-process handlers can never drift apart on a string literal.
 */

/** Request/response channels — `ipcRenderer.invoke` / `ipcMain.handle`. */
export const IPC = {
  library: {
    list: 'library:list',
    add: 'library:add',
    update: 'library:update',
    remove: 'library:remove',
    revealInFolder: 'library:revealInFolder',
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
    addSong: 'playlists:addSong',
    removeSong: 'playlists:removeSong',
    setPlaybackOptions: 'playlists:setPlaybackOptions'
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
  },
  ytdlp: {
    update: 'ytdlp:update'
  }
} as const

/** Main -> renderer push channels — `webContents.send` / `ipcRenderer.on`. */
export const IPC_EVENTS = {
  downloadProgress: 'event:downloadProgress',
  libraryChanged: 'event:libraryChanged',
  error: 'event:error'
} as const

/** The custom protocol audio is served over: `media://audio/<id>`. */
export const MEDIA_SCHEME = 'media'
