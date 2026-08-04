import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AppError } from '../shared/types'

/**
 * The bits of composition that deserve a test.
 *
 * `index.ts` is construction and nothing else, so anything with a decision in it — where the
 * bundled binaries live, whether a window is still there to be sent to, what happens to a failure
 * on its way to the renderer — lives here instead, free of any `electron` import.
 */

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

/**
 * Size in bytes, or `null` for anything that cannot be measured — missing, unreadable, not a file.
 *
 * **Must not reject.** `library:list` runs one of these per song inside a `Promise.all`, so a
 * single rejection would fail the whole listing; and the DTO's `exists` is derived from the result
 * being non-null, so "I could not tell" has to be a value rather than a throw.
 *
 * A real 0-byte file answers `0`, which is deliberately distinct from `null`.
 */
export async function fileSize(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).size
  } catch {
    return null
  }
}

export interface ResourcesBinDirOptions {
  isPackaged: boolean
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** The built main bundle's own directory — `__dirname`, which is `<repo>/out/main` unpackaged. */
  mainDir: string
  platform: NodeJS.Platform
}

/** `out/main` -> the repository root. See `electron.vite.config.ts` for the build layout. */
const MAIN_BUNDLE_DEPTH = ['..', '..']

/**
 * Where the bundled `yt-dlp` lives.
 *
 * electron-builder copies `resources/bin/<platform>/` to `<Resources>/bin` (see the
 * `extraResources` blocks), so the per-platform directory only exists in a checkout.
 *
 * Unpackaged, the checkout is found by walking up from the bundle rather than from
 * `app.getAppPath()`: that returns the directory of whatever script electron was pointed at, so it
 * is the repo root for `electron .` (what `npm run dev` spawns) but `<repo>/out/main` for
 * `electron out/main/index.js` — which is how the e2e harness, and anyone running the build
 * directly, start the app. `__dirname` is the same either way.
 */
export function resolveResourcesBinDir({
  isPackaged,
  resourcesPath,
  mainDir,
  platform
}: ResourcesBinDirOptions): string {
  return isPackaged
    ? path.join(resourcesPath, 'bin')
    : path.join(mainDir, ...MAIN_BUNDLE_DEPTH, 'resources', 'bin', platform)
}

/** The slice of `BrowserWindow` a push channel needs. */
export interface RendererTarget {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

/**
 * A push-channel sender that resolves its window on every call.
 *
 * Lazy on purpose: the IPC handlers are registered before the first window exists, and the window
 * can be closed while a download is still reporting progress. Nothing here may throw — this runs
 * inside the downloader's progress fan-out, where an exception would reach `uncaughtException`.
 */
export function createWindowSender(
  getWindow: () => RendererTarget | null
): (channel: string, payload: unknown) => void {
  return function sendToWindow(channel, payload) {
    try {
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(channel, payload)
    } catch {
      // A window that vanished between the check and the send is not worth a crash.
    }
  }
}

/** The slice of `electron`'s `dialog` and `app` a failed startup needs. */
export interface StartupShell {
  showErrorBox(title: string, content: string): void
  quit(): void
}

/** Shown when the app cannot get far enough to have a window to complain in. */
const STARTUP_FAILURE_TITLE = 'my-music-library could not start'

/**
 * Runs the startup sequence, and turns anything it throws into something the user can read.
 *
 * Everything before the first window — resolving and creating the library root, locating ffmpeg,
 * honouring `MML_LIBRARY_DIR` — can fail on a read-only path, a bad override or an unsupported
 * platform. Inside `app.whenReady().then(...)` those became unhandled rejections: no window, no
 * message, an app that simply never appeared and left the user nothing to act on. A native error
 * box is the only surface available at that point, and there is nothing to do afterwards but quit.
 */
export async function runStartup(
  startup: () => void | Promise<void>,
  shell: StartupShell
): Promise<void> {
  try {
    await startup()
  } catch (error) {
    shell.showErrorBox(
      STARTUP_FAILURE_TITLE,
      error instanceof Error ? error.message : String(error)
    )
    shell.quit()
  }
}

/**
 * Wraps an operation so its failures reach the renderer's toast host as well as its caller.
 *
 * The error is re-thrown untouched: the `invoke` that started the operation still has to reject,
 * because that is what tells the UI the add/delete did not happen.
 */
export function withErrorReport<Args extends unknown[], Result>(
  source: AppError['source'],
  report: (error: AppError) => void,
  operation: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await operation(...args)
    } catch (error) {
      // A cancellation is the user's own doing, so it is not news.
      if (!(error instanceof Error && error.name === 'Cancelled')) {
        report({ source, message: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  }
}
