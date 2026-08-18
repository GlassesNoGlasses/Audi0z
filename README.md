# Audi0z

A lightweight, local-only desktop music library for remixes, mashups, and slowed+reverb edits — the tracks that never make it to streaming services. Built with Electron, React, and TypeScript (and formerly named _my-music-library_). No accounts, no cloud, no telemetry: your music lives in a folder on your machine and the app is just a fast way to play and organize it.

## Features

- **Local library** — import audio files via the file picker; everything is stored under a single library folder you control
- **URL downloads** — paste a link (YouTube and everything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports); the app probes the title, downloads the audio, and imports it with a live progress bar. One download at a time, cancelable mid-flight
- **Opus compression** — a per-download checkbox (with a compress-by-default setting) transcodes imports to Opus 96k via ffmpeg, and any already-imported file can be compressed later from the storage manager. Compression only ever commits when the re-encode actually comes out smaller — otherwise your original file is kept untouched and the app says so. Everywhere the option appears you get a **bold savings estimate** (`~3.6 MB save`, or a generic `Saves ~25%` when it can't be computed)
- **Tags** — a first-class tag registry managed from the **Tags** dialog (GitHub-style colored chips, random color per tag); renaming or deleting a tag cascades through every song. Songs pick their tags from the registry via each row's `…` menu, where every option now shows the full colored chip — not just its name
- **Storage manager** — Settings shows the library's total size with a **Show** button that reveals the audio folder, plus a per-file list sorted by size where each file can be compressed or deleted in place
- **Playlists** — create, rename, and delete playlists; deleting a playlist never deletes its songs. **Drag playlists up and down the sidebar to reorder them** — the order is saved. While something is playing, the sidebar marks the playlist (or Library) the queue came from with an accent bar, independently of which view you're browsing. Fill a playlist from the whole library with the Spotify-style **Add Song** dialog (search + one-tap add; only songs the playlist doesn't have yet are offered, and a row disappears the moment you add it). Per-playlist shuffle and repeat settings, plus independent shuffle/repeat for the main library queue. A search box in the sidebar filters the playlist list by name, and **New playlist** sits pinned at the panel's bottom edge however long the list grows
- **Sorting** — the sort menu in the top bar orders the current view (Library or playlist) by **Date added** or **Duration**, each direction-toggling on a second click, with **Manual order** to return to the stored order. The play queue follows the sort — resorting mid-listen reorders what comes next without interrupting the song
- **Real playback engine** — play/pause, next, previous (with true history — previous returns to what actually played, even under shuffle; past five seconds into a song it restarts the song instead, like every player since the iPod), seek, volume (persisted), played-song tracking per queue, auto-skip past broken files. AirPods taps, keyboard media keys, and the macOS Now Playing widget drive the same transport — double tap for next, triple tap for previous (with the same five-second restart rule). Browsing never interrupts it: switching the sidebar view keeps the music playing, and the top bar's play button pauses and resumes the view it's already playing instead of restarting it. Scrubbing the seek slider is silent until you let go
- **Keyboard shortcuts** — Space toggles play/pause (when a song is loaded — it always pauses, never restarts a clicked row), `←`/`→` skip back/forward 10 seconds (capped at the song's ends, silent until you stop skipping), `M` mutes/unmutes. Clicking a button or slider never captures the keyboard: focus is released after every mouse click, so the shortcuts keep working no matter what you last clicked
- **Search** — filters the visible list without touching the play queue: clicking a filtered row plays it within the full queue order
- **Safe deletes** — removing a song (from a row's `…` menu or the storage manager) moves its file to the system Trash (recoverable), then cascades it out of every playlist
- **Rich rows** — every song row shows its duration, the date it was added (MM/DD/YYYY), and its file size (durations are measured automatically in the background — while nothing is playing, so measuring never competes with your music — and remembered)

## Installing

Prebuilt binaries are not distributed; you build the installer yourself from source (a few minutes). All three platforms need:

- [Node.js](https://nodejs.org) **v22.23.2** (the pinned version in `.nvmrc` — with [nvm](https://github.com/nvm-sh/nvm): `nvm install`)
- `npm ci` run once in the repo (this also downloads Electron and the ffmpeg binary via postinstall)

The packaging scripts automatically fetch the pinned [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary (version 2026.07.04, SHA-256 verified) for your platform before building.

### macOS (Apple Silicon)

```bash
npm ci
npm run dist:mac
```

The installer lands at `dist/Audi0z-<version>-arm64.dmg` — and a copy is placed on your **Desktop** so you don't have to dig for it. Open it and drag the app to Applications.

**First launch:** the app is ad-hoc signed, not notarized, so Gatekeeper will refuse a normal double-click on a downloaded copy ("cannot be opened because the developer cannot be verified"). **Right-click the app → Open → Open** the first time; after that it opens normally. This is expected for a self-built app without an Apple Developer ID. (If you're upgrading from a build made under the old _my-music-library_ name, macOS treats Audi0z as a new app, so the right-click dance happens once more.)

### Windows

```bash
npm ci
npm run dist:win
```

Produces an NSIS installer under `dist/` (with a copy on your Desktop). Run it and follow the prompts. SmartScreen may warn about an unrecognized app — choose "More info → Run anyway" (the installer is unsigned).

> The Windows target is configured but has not been exercised by this project's release verification (which ran on macOS). Please report issues.

### Linux

```bash
npm ci
npm run dist:linux
```

Produces an AppImage under `dist/` (with a copy on your Desktop). Make it executable and run it:

```bash
chmod +x dist/Audi0z-*.AppImage
./dist/Audi0z-*.AppImage
```

> Like Windows, the Linux target is configured but untested by the release verification.

### Running from source (development)

```bash
nvm use            # or otherwise select Node v22.23.2
npm ci
npm run fetch:ytdlp   # yt-dlp binaries for URL downloads (skippable if you never download)
npm run dev           # launches the app with hot reload
```

## Where your music lives

Everything is stored in one folder:

| Platform | Default location            |
| -------- | --------------------------- |
| all      | `~/Music/audi0z/` |

The folder deliberately keeps the app's original name: libraries created before the rename to Audi0z keep working untouched, and nothing about your data moves.

Inside it: `audio/` (the actual files, named by internal id), `library.json` (song metadata), `playlists.json`, `tags.json` (the tag registry), and `settings.json`. All four JSON files are written atomically (temp file → fsync → rename), so a crash mid-write can't corrupt them; a corrupted file found at startup is quarantined to `.bak` and the app continues with defaults.

To use a different folder (or keep multiple libraries), set the `MML_LIBRARY_DIR` environment variable before launching.

## Using the app

- **Add songs:** the download icon (top right) opens a dialog with two sources — local file(s) via the file picker, or a URL. Each mode says what it accepts: the file side lists the playable formats (MP3, M4A, AAC, FLAC, WAV, OGG, Opus, WebM), the URL side explains yt-dlp coverage and that a playlist link fetches only the linked item. The URL flow probes the title first (a spinner notes that the first probe after launch can take ~30 seconds — the bundled yt-dlp binary is slow to cold-start; later ones are quicker), then downloads with a live progress bar showing percent and bytes. Download errors surface as toasts with yt-dlp's actual message. Tags are picked from the registry's chips.
- **Views vs. queues:** clicking "Library" or a playlist in the sidebar only changes what you're _looking at_ — the music keeps playing. The queue actually switches when you play a song from the new view (click a row, or hit the highlighted play button in the top bar, which starts the first song — or a random one if that view has shuffle on). When the view you're looking at is already the one playing, that same button is its pause/resume toggle. While a song is cued, the sidebar entry the queue came from carries an accent marker — so you can always see where the sound is coming from, even while browsing somewhere else. The expand/collapse chevron on a playlist only shows its songs.
- **Reordering playlists:** drag a playlist up or down the sidebar; an accent seam shows which edge it will land on, and the new order is saved. Dragging pauses while the sidebar's filter is narrowing the list (a partial list can't say where the hidden ones go) or while a rename is open.
- **Sorting:** the sort icon (left of the download icon) offers Manual order, Date added, and Duration — click a field to sort ascending, click it again to flip. The sort applies to whichever view you're in and carries into the play queue; it never rewrites the stored order, and it resets to Manual on relaunch.
- **Filling playlists:** in a playlist view, the "Add Song" button (next to the search bar) opens a search-the-whole-library dialog that only offers songs the playlist doesn't already have — `+` adds a song and its row disappears on the spot. When there's nothing left to offer, the dialog says which reason applies (empty library, no search match, or everything's already in).
- **Tags:** the "Tags" button in the top bar is the only place tags are created, renamed, or deleted — renames and deletions apply to every song instantly. Give a song its tags from the row's `…` menu, where each option shows its full colored chip.
- **Storage:** Settings shows the total size of your audio files with a "Show" button that opens the folder, and an expandable file list sorted by size — compress any uncompressed file (the bold estimate tells you roughly what you'd save; the song currently loaded in the player can't be compressed until you play something else) or delete it. If a file is already smaller than its Opus re-encode would be, the original is kept and a toast tells you — nothing is lost to a compression that wouldn't pay.
- **Shuffle/repeat:** the player-bar toggles apply to the current queue and persist — per playlist for playlist queues, in settings for the Library queue. An active toggle is highlighted.
- **Shortcuts:** Space pauses/resumes the current song (does nothing when nothing is loaded — and it always pauses, even right after clicking a row, instead of restarting it); `←`/`→` skip back/forward 10 seconds, staying silent until you stop skipping; `M` mutes and unmutes, restoring your previous volume. All of them stay out of the way while you're typing or a dialog is open — and clicking things (rows, the player bar, playlists) no longer parks focus anywhere that would swallow them.
- **Toasts:** error messages stack, auto-dismiss after 10 seconds, and can be dismissed by hand.
- **Missing files:** if a file was moved or deleted outside the app, its row is flagged and unplayable; playback auto-skips past songs that fail to play. Deleting a missing song from the library works (there is just no file to trash).
- **Settings:** the storage manager above and compress-by-default for downloads. The dialog closes with **Ok**; every setting in it takes effect the moment you change it. (The "Update yt-dlp" button is gone as of v3.2 — the app always runs its pinned, bundled yt-dlp, and startup cleans up any self-updated copy an older build left behind.)

## Development reference

| Command                                        | What it does                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                                  | run the app with hot reload                                        |
| `npm test`                                     | full unit/component suite (vitest, node + jsdom projects)          |
| `npm run e2e`                                  | build, then Playwright end-to-end suite driving the real built app |
| `npm run typecheck` / `lint` / `format`        | the usual hygiene                                                  |
| `npm run package`                              | unpacked build in `dist/` (no installer)                           |
| `npm run dist:mac` / `dist:win` / `dist:linux` | platform installers (a copy lands on your Desktop)                 |
| `npm run fetch:ytdlp`                          | (re)download the pinned yt-dlp binaries into `resources/bin/`      |

`APP-SUMMARY.txt` in the repo root walks through the entire architecture file by file. `DESIGN.md` and `PLAN.txt` record the original design and build plan.

## Third-party software

The packaged app bundles a **GPL build of ffmpeg** (via `ffmpeg-static`) and downloads the **yt-dlp** binary (Unlicense). See `NOTICE.md` for the licensing details and obligations.

## License

Private / UNLICENSED. Not currently distributed.
