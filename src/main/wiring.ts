import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AppError } from '../shared/types'

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

// Returns file size as a number. Returns `null` if not a file or error
export async function fileSize(absPath: string): Promise<number | null> {
  try {
    const info = await stat(absPath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

export interface ResourcesBinDirOptions {
  isPackaged: boolean // false for dev
  resourcesPath: string
  mainDir: string
  platform: NodeJS.Platform
}

// `out/main` -> the repository root build; see `electron.vite.config.ts` for the build layout
const MAIN_BUNDLE_DEPTH = ['..', '..']


// Path of `yt-dlp` binary for build/dev
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

// Push channel to main `BrowserWindow` by a renderer
export interface RendererTarget {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

// Push channel to send to window; used by yt-dlp process to send payload
export function createWindowSender(
  getWindow: () => RendererTarget | null
): (channel: string, payload: unknown) => void {
  return function sendToWindow(channel, payload) {
    try {
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(channel, payload)
    } catch {
      return
    }
  }
}

// Startup shell feedback
export interface StartupShell {
  showErrorBox(title: string, content: string): void
  quit(): void
}

const STARTUP_FAILURE_TITLE = 'Audi0z could not start'

// Runs the startup sequence, and turns anything it throws into something the user can read
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


// Wraps an operation to report errors view renderer's toast
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
