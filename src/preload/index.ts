import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipc'
import type { Api } from '../shared/api'
import type { AppError, DownloadProgress } from '../shared/types'

// IPC main -> renderer push channel, returning unsubscribe function via contextBridge
function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as Args))
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// Main IPC API
export const api: Api = {
  library: {
    list: () => ipcRenderer.invoke(IPC.library.list),
    add: (req) => ipcRenderer.invoke(IPC.library.add, req),
    update: (id, patch) => ipcRenderer.invoke(IPC.library.update, id, patch),
    updateDurations: (entries) => ipcRenderer.invoke(IPC.library.updateDurations, entries),
    remove: (id) => ipcRenderer.invoke(IPC.library.remove, id),
    compress: (id) => ipcRenderer.invoke(IPC.library.compress, id),
    showFolder: () => ipcRenderer.invoke(IPC.library.showFolder)
  },
  tags: {
    list: () => ipcRenderer.invoke(IPC.tags.list),
    create: (name) => ipcRenderer.invoke(IPC.tags.create, name),
    rename: (id, name) => ipcRenderer.invoke(IPC.tags.rename, id, name),
    remove: (id) => ipcRenderer.invoke(IPC.tags.remove, id)
  },
  playlists: {
    list: () => ipcRenderer.invoke(IPC.playlists.list),
    create: (name) => ipcRenderer.invoke(IPC.playlists.create, name),
    remove: (id) => ipcRenderer.invoke(IPC.playlists.remove, id),
    rename: (id, name) => ipcRenderer.invoke(IPC.playlists.rename, id, name),
    reorder: (orderedIds) => ipcRenderer.invoke(IPC.playlists.reorder, orderedIds),
    addSong: (playlistId, songId) => ipcRenderer.invoke(IPC.playlists.addSong, playlistId, songId),
    removeSong: (playlistId, songId) =>
      ipcRenderer.invoke(IPC.playlists.removeSong, playlistId, songId),
    setPlaybackOptions: (id, opts) => ipcRenderer.invoke(IPC.playlists.setPlaybackOptions, id, opts),
    reorderSongs: (playlistId, songIds) => ipcRenderer.invoke(IPC.playlists.reorderSongs, playlistId, songIds)
  },
  files: {
    pickAudioFiles: () => ipcRenderer.invoke(IPC.files.pickAudioFiles)
  },
  download: {
    probe: (url) => ipcRenderer.invoke(IPC.download.probe, url),
    start: (req) => ipcRenderer.invoke(IPC.download.start, req),
    cancel: () => ipcRenderer.invoke(IPC.download.cancel),
    onProgress: (cb) => subscribe<[DownloadProgress]>(IPC_EVENTS.downloadProgress, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (patch) => ipcRenderer.invoke(IPC.settings.set, patch)
  },
  events: {
    onLibraryChanged: (cb) => subscribe<[]>(IPC_EVENTS.libraryChanged, cb),
    onError: (cb) => subscribe<[AppError]>(IPC_EVENTS.error, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
