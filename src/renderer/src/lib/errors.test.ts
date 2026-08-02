import { describe, expect, it } from 'vitest'
import { errorMessage, isBusy, isCancelled, isTrashFailure } from './errors'

/**
 * `ipcMain.handle` rejections reach the renderer as a plain `Error` whose custom `name`/`code` are
 * gone and whose message is prefixed by Electron — everything here works on that string.
 */

const busy = new Error(
  "Error invoking remote method 'download:start': BUSY: a download is already running"
)
const cancelled = new Error(
  "Error invoking remote method 'download:start': Cancelled: download cancelled"
)
const trash = new Error(
  "Error invoking remote method 'library:remove': Error: Failed to move item to trash"
)

describe('errorMessage', () => {
  it('strips the electron invoke prefix', () => {
    expect(errorMessage(busy)).toBe('a download is already running')
  })

  it('strips the serialised error name, leaving what main would have sent itself', () => {
    expect(errorMessage(trash)).toBe('Failed to move item to trash')
    expect(errorMessage(new Error('YtDlpError: yt-dlp download failed (exit 1)'))).toBe(
      'yt-dlp download failed (exit 1)'
    )
  })

  it('leaves an ordinary sentence alone', () => {
    expect(errorMessage(new Error('the library directory is read-only'))).toBe(
      'the library directory is read-only'
    )
  })

  it('describes non-Error rejections without throwing', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage(undefined)).toBe('Something went wrong')
  })
})

describe('error classification', () => {
  it('recognises a busy downloader by message, not by name', () => {
    expect(busy.name).toBe('Error')
    expect(isBusy(busy)).toBe(true)
    expect(isBusy(cancelled)).toBe(false)
  })

  it('recognises a cancelled download', () => {
    expect(isCancelled(cancelled)).toBe(true)
    expect(isCancelled(busy)).toBe(false)
  })

  it('recognises a failed trash operation', () => {
    expect(isTrashFailure(trash)).toBe(true)
    expect(isTrashFailure(busy)).toBe(false)
  })
})
