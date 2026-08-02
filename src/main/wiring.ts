import { access } from 'node:fs/promises'
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

export interface ResourcesBinDirOptions {
  isPackaged: boolean
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.getAppPath()` — the repository root during development. */
  appPath: string
  platform: NodeJS.Platform
}

/**
 * Where the bundled `yt-dlp` lives.
 *
 * electron-builder copies `resources/bin/<platform>/` to `<Resources>/bin` (see the
 * `extraResources` blocks), so the per-platform directory only exists in a checkout.
 */
export function resolveResourcesBinDir({
  isPackaged,
  resourcesPath,
  appPath,
  platform
}: ResourcesBinDirOptions): string {
  return isPackaged
    ? path.join(resourcesPath, 'bin')
    : path.join(appPath, 'resources', 'bin', platform)
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
