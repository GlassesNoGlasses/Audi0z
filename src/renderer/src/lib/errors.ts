/**
 * Recognising main-process failures from the renderer.
 *
 * `ipcMain.handle` serialises a rejection into a plain `Error`: the custom `name` and `code` the
 * main process set are gone by the time the renderer sees it, and the message arrives wrapped as
 * `Error invoking remote method '<channel>': <Name>: <message>`. So every check here is a
 * substring match on the message, and it lives in one place rather than being re-derived at each
 * call site.
 */

const INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
/**
 * The error's class name, which electron pastes in front of the message it serialises
 * (`YtDlpError: …`, `BUSY: …`). It is an implementation detail of the main process, and dropping
 * it leaves the sentence the user is meant to read.
 */
const NAME_PREFIX = /^[A-Z][A-Za-z0-9_]*:[ \t]+/

/** A message fit to show a human, with electron's IPC wrapper unwrapped. */
export function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '')
  const unwrapped = raw.replace(INVOKE_PREFIX, '').replace(NAME_PREFIX, '').trim()
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

/** The OS refused to move the file to the trash, so the song is still in the library. */
export function isTrashFailure(error: unknown): boolean {
  return /trash/i.test(errorMessage(error))
}
