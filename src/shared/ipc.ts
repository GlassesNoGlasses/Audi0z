/** Channel and scheme names shared across the main/preload/renderer boundary. */

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

// Main -> renderer push events, subscribed to in the preload.
export const IPC_EVENTS = {
  downloadProgress: 'event:downloadProgress',
  libraryChanged: 'event:libraryChanged',
  error: 'event:error'
} as const

// App scheme `media://audio/<id>`
export const MEDIA_SCHEME = 'media'
