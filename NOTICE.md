# Third-party notices

`my-music-library` bundles and/or executes third-party software. This file records the
licensing obligations that come with them.

## ffmpeg (via `ffmpeg-static`)

The `ffmpeg-static` npm package downloads a prebuilt `ffmpeg` binary at install time and the
packaged app ships that binary (it is unpacked from the asar archive via `asarUnpack`).

Those prebuilt binaries are **GPL builds of FFmpeg** (they are compiled with GPL-licensed
components enabled). FFmpeg itself is licensed under the LGPL v2.1 or later, but GPL builds are
covered by the **GPL v2.1 or later**. Distributing the app therefore carries GPL obligations,
including making the corresponding source of FFmpeg available to recipients.

- FFmpeg project: https://ffmpeg.org
- FFmpeg license/legal: https://ffmpeg.org/legal.html
- `ffmpeg-static` (npm wrapper, MIT): https://github.com/eugeneware/ffmpeg-static
- Prebuilt binary source: https://github.com/eugeneware/ffmpeg-static/releases

## yt-dlp

`scripts/fetch-ytdlp.mjs` downloads the pinned standalone `yt-dlp` release binary into
`resources/bin/<platform>/`, and the packaged app ships it as an extra resource. It is executed as
a separate process; it is never linked into the app.

`yt-dlp` is released into the public domain under **The Unlicense**.

- Project: https://github.com/yt-dlp/yt-dlp
- License: https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE

## Electron / Chromium / Node.js

The app is built on Electron, which embeds Chromium and Node.js. Electron is licensed under the
MIT license; Chromium, Node.js and their own dependencies carry their respective licenses.

The full, authoritative license text for a given Electron build ships inside the packaged
application and inside the installed `electron` npm package:

- `node_modules/electron/dist/LICENSE` (Electron, MIT)
- `node_modules/electron/dist/LICENSES.chromium.html` (Chromium and its dependencies)
- Electron project: https://github.com/electron/electron

## npm dependencies

All remaining runtime and build-time dependencies are standard npm packages under permissive
licenses (MIT / ISC / Apache-2.0). Run `npm ls --all` for the exact tree of a given build.
