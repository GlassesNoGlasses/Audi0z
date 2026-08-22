/**
 * Recognising main-process failures. `ipcMain.handle` drops the custom `name`/`code` and wraps the
 * message as `Error invoking remote method '<channel>': <Name>: <message>`, so every check here is
 * a substring match.
 */

import type { Dispatch } from 'react'
import type { AppAction } from '../state/appReducer'

const INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
/**
 * Electron's serialised class-name prefix (`YtDlpError: …`). Only ever applied behind
 * `INVOKE_PREFIX`: the shape is indistinguishable from an errno, so off the wrapper it eats words.
 */
const NAME_PREFIX = /^[A-Z][A-Za-z0-9_]*:[ \t]+/

/** A message fit to show a human, with electron's IPC wrapper unwrapped. */
export function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '')
  // No wrapper means no serialisation, so a leading `ENOENT: ` there is the message itself.
  const unwrapped = INVOKE_PREFIX.test(raw)
    ? raw.replace(INVOKE_PREFIX, '').replace(NAME_PREFIX, '').trim()
    : raw.trim()
  return unwrapped === '' ? 'Something went wrong' : unwrapped
}

/** A second download was requested while one was still running (`downloader`'s `BUSY`). */
export function isBusy(error: unknown): boolean {
  return /\bBUSY\b|already running/i.test(errorMessage(error))
}

/** The user cancelled the download — not a failure, so it must not be reported as one. */
export function isCancelled(error: unknown): boolean {
  return /cancell?ed/i.test(errorMessage(error))
}

/**
 * The OS refused to trash the file, so the song is still in the library. Errs wide: `trashItem`'s
 * wording is per-platform, and the suffix it gates is true of any failed delete anyway.
 */
export function isTrashFailure(error: unknown): boolean {
  return /trash/i.test(errorMessage(error))
}

/** The delete-refused toast, told identically wherever a delete can fail. */
export function trashFailureMessage(error: unknown): string {
  return isTrashFailure(error)
    ? `${errorMessage(error)} — the song is still in your library.`
    : errorMessage(error)
}

/** The one way an async failure reaches the user: normalised message, pushed as a toast. */
export function toastError(dispatch: Dispatch<AppAction>, error: unknown): void {
  dispatch({ type: 'toast/pushed', message: errorMessage(error) })
}
