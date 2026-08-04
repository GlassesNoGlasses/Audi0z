import { useMemo, useState, type ReactElement } from 'react'
import type { SongDto } from '../../../shared/types'
import { refreshLibrary } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { errorMessage } from '../lib/errors'
import { formatBytes, formatCompressionSaving } from '../lib/format'
import { useAppDispatch, useAppState } from '../state/AppContext'

/** Heaviest first; a file whose size could not be read has nothing to sort by, so it sinks. */
function bySizeDescending(songs: SongDto[]): SongDto[] {
  return [...songs].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1))
}

export function SettingsDialog(): ReactElement {
  const { settings, songs } = useAppState()
  const dispatch = useAppDispatch()
  const [updating, setUpdating] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  /** Ids whose compression is in flight — the button they came from stays disabled meanwhile. */
  const [compressing, setCompressing] = useState<ReadonlySet<string>>(new Set())
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  useEscapeKey(close)

  const fail = (error: unknown): void =>
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })

  const total = songs.reduce((bytes, song) => bytes + (song.sizeBytes ?? 0), 0)
  const listed = useMemo(() => bySizeDescending(songs), [songs])

  function toggleCompress(compressByDefault: boolean): void {
    void window.api.settings
      .set({ compressByDefault })
      .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
      .catch(fail)
  }

  function updateYtDlp(): void {
    setUpdating(true)
    void window.api.ytdlp
      .update()
      .then(({ version }) =>
        dispatch({ type: 'toast/pushed', message: `yt-dlp updated to ${version}` })
      )
      .catch(fail)
      .finally(() => setUpdating(false))
  }

  function markCompressing(songId: string, busy: boolean): void {
    setCompressing((current) => {
      const next = new Set(current)
      if (busy) next.add(songId)
      else next.delete(songId)
      return next
    })
  }

  function compress(song: SongDto): void {
    markCompressing(song.id, true)
    void window.api.library
      .compress(song.id)
      .then((updated) => {
        dispatch({ type: 'library/songUpdated', song: updated })
        dispatch({ type: 'toast/pushed', message: `Compressed "${updated.title}"` })
      })
      .catch(fail)
      .finally(() => markCompressing(song.id, false))
  }

  function remove(songId: string): void {
    setConfirmingId(null)
    void window.api.library
      .remove(songId)
      .then(() => refreshLibrary(dispatch))
      .catch(fail)
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>Settings</h2>

        <p className="storage-row">
          Storage: <strong>{formatBytes(total)}</strong>
          <button
            type="button"
            onClick={() => {
              void window.api.library.showFolder().catch(fail)
            }}
          >
            Show
          </button>
        </p>

        <div className="settings-files">
          <button
            type="button"
            className="disclosure"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen((open) => !open)}
          >
            <span aria-hidden="true">{filesOpen ? '▾' : '▸'}</span> Audio files
          </button>
          {filesOpen ? (
            <ul className="file-list">
              {listed.map((song) => (
                <li key={song.id} className="file-row">
                  <span className="file-size">{formatBytes(song.sizeBytes)}</span>
                  <span className="file-title">{song.title}</span>
                  {song.compressed ? null : (
                    <>
                      <button
                        type="button"
                        className="btn-grey"
                        aria-label={`Compress ${song.title}`}
                        disabled={compressing.has(song.id)}
                        onClick={() => compress(song)}
                      >
                        Compress
                      </button>
                      <strong className="compress-estimate">
                        {formatCompressionSaving(song.sizeBytes, song.durationSec)}
                      </strong>
                    </>
                  )}
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Delete ${song.title}`}
                    onClick={() => setConfirmingId(song.id)}
                  >
                    Delete
                  </button>
                  {/*
                    Confirmed here rather than through the global confirm dialog: there is one
                    dialog slot, so that one would close this one and lose the list the user was
                    working down.
                  */}
                  {confirmingId === song.id ? (
                    <div className="confirm-strip">
                      <span>Move {song.title} to the trash?</span>
                      <button type="button" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </button>
                      <button type="button" className="danger" onClick={() => remove(song.id)}>
                        Delete
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/*
          The estimate sits beside the label rather than inside it: the checkbox is named by its
          label, and a saving figure in there would rename the preference itself.
        */}
        <div className="checkbox-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.compressByDefault}
              onChange={(event) => toggleCompress(event.target.checked)}
            />
            Compress new songs by default
          </label>
          <span className="compress-note">
            —{' '}
            <strong className="compress-estimate">
              {formatCompressionSaving(null, undefined)}
            </strong>
          </span>
        </div>
        <p className="dialog-hint">
          Compression re-encodes to Opus 128k on the way in. It saves space and loses a little
          quality.
        </p>
        <div className="dialog-actions">
          <button type="button" disabled={updating} onClick={updateYtDlp}>
            Update yt-dlp
          </button>
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
