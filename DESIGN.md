# my-music-library — design

## What it is

A lightweight, **local-only** Electron desktop music library (macOS / Windows / Linux) built for
remixes, mashups and slowed+reverb edits — the kind of tracks that do not live in a streaming
service.

Songs are added three ways: a file picker, drag-and-drop, or a URL handed to `yt-dlp`. Every song
carries free-form tags. Songs are grouped into playlists. Playback has played/shuffle/repeat
semantics (see _Playback engine_ below).

## Architecture

Three processes, one direction of trust: the renderer asks, the main process does.

### Main process — owns all disk I/O and child processes

- **Library root**: `~/Music/my-music-library/` (overridable with `MML_LIBRARY_DIR`, which exists
  so unit tests and e2e runs get an isolated directory).
  - `library.json` — `{ version: 1, songs: Song[] }`
  - `playlists.json` — `{ version: 1, playlists: Playlist[] }`
  - `settings.json` — `Settings`
  - `audio/<uuid><ext>` — the audio files themselves
- **JSON stores** with **atomic writes** (write to a temp file, then rename over the target) so a
  crash mid-write can never truncate the library.
- **Child processes**: the bundled standalone `yt-dlp` binary (downloads) and the `ffmpeg-static`
  binary (optional transcode). No Python is required or installed.
- **Custom protocol**: audio is served to the renderer over `media://audio/<id>` with HTTP
  **Range** support, so `<audio>` can seek without loading whole files. The scheme is registered
  as privileged (`standard`, `secure`, `supportFetchAPI`, `stream`, `corsEnabled`) before
  `app.whenReady()`.

### Preload — the only bridge

A single typed `Api` object (`src/shared/api.ts`) exposed through `contextBridge` as `window.api`.
Every method is a thin `ipcRenderer.invoke` / `ipcRenderer.on` passthrough — no logic lives here.
`contextIsolation` is on, `nodeIntegration` is off, `sandbox` is off (the preload needs
`webUtils.getPathForFile`, which is how drag-and-drop file paths are obtained now that Electron
removed `File.path`).

### Renderer — React 18 + TypeScript

Owns the UI and a **pure playback engine**: given a queue and the current state it returns the
next state. No I/O, no timers, fully unit-testable.

## Playback engine semantics

Played flags are per-queue and live **in memory only** — they are never persisted.

- **Sequential**: advance through the queue; on wrap, reset all played flags and replay from the
  first song.
- **Shuffle**: pick a random **unplayed** song. When the queue is exhausted, reset the flags
  _excluding the song that just finished_ (so it cannot immediately repeat).
- **Repeat**: replay the current song without touching played flags.
- **Manual click**: play the clicked song and reset every _other_ song's played flag.
- **Previous**: pop from a capped history stack.
- **Invariant**: if `currentId` is set, that song is marked played.

## Key decisions

- **No Python.** `yt-dlp` is shipped as a pinned standalone binary per platform.
- Songs store a **`fileName`, not a path** — the library directory can move.
- **Switching queue stops playback** (no surprise cross-fade between contexts).
- **One download at a time**; the URL flow is two-step: `probe` → user confirms title/tags →
  `start`.
- **Delete moves the file to the OS trash**, and the library record is only removed if the trash
  operation succeeded (abort on trash failure — never orphan the record).
- **Compression is optional**: an `ffmpeg` transcode to Opus 128k, chosen per-add and defaulted
  from settings.
- **v1 ships unsigned builds** (mac dmg, win nsis, linux AppImage).
- Played flags are **not persisted**; shuffle/repeat **are** persisted per playlist (the Library
  view's own shuffle/repeat live in `settings.json`).

## Repository layout

```
src/
  main/        main process: stores, ipc handlers, child processes, media protocol
  preload/     contextBridge Api passthrough + window.api typings
  renderer/    React UI + pure playback engine
  shared/      types, ipc channel names, the Api contract (imported by all three)
tests/
  support/     mock Api, WAV generator, tmp library helpers (no binary fixtures)
  e2e/         Playwright tests driving the built Electron binary
scripts/       fetch-ytdlp.mjs (pinned, checksum-verified binary download)
```

Cross-directory imports are plain relative paths (`../shared/types`) — there are no path aliases
to keep the four build configs (`electron.vite.config.ts`, `vitest.config.ts`, the two tsconfigs)
free of resolution drift.

## Contracts

`src/shared/types.ts`, `src/shared/api.ts`, `src/shared/ipc.ts` and
`src/main/store/storeTypes.ts` are **frozen**: they are the seam between work packages. Changing
them means changing every package that depends on them.
