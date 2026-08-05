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
  - `tags.json` — `{ version: 1, tags: Tag[] }`, the registry behind the plain strings songs carry
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
- **The view and the queue are separate things.** Choosing Library or a playlist in the sidebar
  changes only what is listed — playback carries on untouched. The queue follows when the user
  plays a song from another view: that song starts in the new queue. A queue switch with no song
  to start still stops playback (no surprise cross-fade between contexts).
- **Sorting belongs to the view, and the queue follows it.** The top bar's sort menu orders
  whatever is on screen — Library or playlist — by date added or playing time, ascending on the
  first press of a mode and flipping on the next. Manual, the default, is the stored order: the
  library's insertion order, a playlist's own. The sort is a **view-layer, session-only** thing —
  one field on the renderer's state tree, written to neither `settings.json` nor the playlist, so
  a relaunch is back to Manual and no stored order is ever rewritten. It is applied in exactly one
  place (`songsInView`/`sortSongs`), which is what keeps the list, the top bar's play button and
  the queue re-sync agreeing: reordering the view reorders the queue behind the song that is
  playing, without interrupting it. Songs the duration backfill has not reached yet have no
  playing time to sort by, so they sink to the end in both directions.
- **One download at a time**; the URL flow is two-step: `probe` → user confirms title/tags →
  `start`.
- **Delete moves the file to the OS trash**, and the library record is only removed if the trash
  operation succeeded (abort on trash failure — never orphan the record).
- **Compression is optional, and asking for it is not a promise of it**: an `ffmpeg` transcode to
  Opus 96k, chosen per-add and defaulted from settings. 96k rather than 128k because the
  downloader's own `bestaudio[ext=m4a]` is already ~128k AAC: matching it left no saving worth the
  re-encode, and could grow the file instead. Since a lean lossy source can still re-encode bigger,
  both compression paths stage the output beside the target and measure it against the source
  before committing, and the tie goes to the original. On import, a re-encode that is not smaller
  is deleted and the source copied in as it stands (`compressed: false`). For the Settings
  dialog's per-song Compress, nothing at all is recorded — the row stays uncompressed, the file
  never moves, and the handler answers `shrank: false` so the UI can say the original was kept
  rather than claim a compression that did not happen.
- **Targets are mac dmg, win nsis, linux AppImage**, and the macOS build is **ad-hoc signed, not
  unsigned**. Packaging rewrites the bundle and breaks the seal Electron ships with, which macOS
  refuses outright on arm64, so an `afterPack` hook (`build/adhocSign.js`) runs `codesign --sign -`
  over the packed `.app`. That buys no Gatekeeper trust: the first launch still needs right-click
  Open.
- Played flags are **not persisted**; shuffle/repeat **are** persisted per playlist (the Library
  view's own shuffle/repeat live in `settings.json`).
- **Tag rename and delete are not transactional.** The registry (`tags.json`) is written first, then
  the cascade through `library.json` — two files, two writes, no rollback. A refused registry write
  never cascades, so only a failed library write can leave the two disagreeing, and what it strands
  is a tag string on the songs that no registry entry names any more (re-running the rename will not
  clear it — the registry already holds the new name).
- **`event:libraryChanged` is declared but never sent.** The main process pushes only
  `event:downloadProgress` and `event:error`; the renderer re-reads the library itself after every
  mutation. The channel and its `onLibraryChanged` subscription are kept for the day a change from
  outside (another window, a synced folder) has to be pushed — the test mock emits it, which is what
  keeps that path exercised.

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
build/         packaging assets: entitlements, the ad-hoc sign hook, the icon + its AVIF source
```

Cross-directory imports are plain relative paths (`../shared/types`) — there are no path aliases
to keep the four build configs (`electron.vite.config.ts`, `vitest.config.ts`, the two tsconfigs)
free of resolution drift.

The app icon is generated from `build/icon-source.avif` with macOS system tools: center-crop to a
square on the 528px short side, upscale to 1024 for the `icon.png` master, then a `sips` size ladder
off that master into `iconutil -c icns`. electron-builder finds `build/icon.icns` and
`build/icon.png` by convention (`directories.buildResources`) — no config key points at them.

## Contracts

`src/shared/types.ts`, `src/shared/api.ts`, `src/shared/ipc.ts` and `src/main/store/storeTypes.ts`
are the seam between the three processes. They are not frozen — v2 widened them and this branch
added `library.updateDurations` and dropped `revealInFolder` — but they only move **additively, or
by a sweep that removes**: a member is never quietly redefined under its callers, and either way one
commit lands the change in all four consumers at once. Those are the contract
(`src/shared/api.ts`), the bridge (`src/preload/index.ts`), the test double
(`tests/support/mockApi.ts`) and the main-process handler that answers the channel
(`src/main/ipc/`). Half a sweep does not compile, and the seam the compiler cannot see across — the
mock — is held to the preload's exact shape by `src/shared/api.test.ts`.
