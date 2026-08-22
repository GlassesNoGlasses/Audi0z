import { useMemo, useState, type ReactElement } from 'react'
import type { SongDto } from '../../../shared/types'
import { refreshLibrary } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useToastError } from '../hooks/useToastError'
import { trashFailureMessage } from '../lib/errors'
import { formatBytes, formatCompressionSaving } from '../lib/format'
import { useAppDispatch, useAppState } from '../state/AppContext'

/** ffmpeg rewrites the file in place, so the cued `<audio>`'s next Range request would fail. */
const HELD_BY_PLAYER = 'Cannot compress file currently playing.'

/** Heaviest first; a file whose size could not be read has nothing to sort by, so it sinks. */
function bySizeDescending(songs: SongDto[]): SongDto[] {
  return [...songs].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1))
}

export function SettingsDialog(): ReactElement {
  const { settings, songs, playback } = useAppState()
  const dispatch = useAppDispatch()
  const [filesOpen, setFilesOpen] = useState(false)
  /** Ids whose compression is in flight — the button they came from stays disabled meanwhile. */
  const [compressing, setCompressing] = useState<ReadonlySet<string>>(new Set())
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  useEscapeKey(close)

  const fail = useToastError()

  const total = songs.reduce((bytes, song) => bytes + (song.sizeBytes ?? 0), 0)
  const listed = useMemo(() => bySizeDescending(songs), [songs])

  function toggleCompress(compressByDefault: boolean): void {
    void window.api.settings
      .set({ compressByDefault })
      .then((updated) => dispatch({ type: 'settings/updated', settings: updated }))
      .catch(fail)
  }

  function markCompressing(songId: string, busy: boolean): void {
    setCompressing((current) => {
      const next = new Set(current)
      if (busy) next.add(songId)
      else next.delete(songId)
      return next
    })
  }

  /** A re-encode that came out no smaller is discarded — the toast is the only sign of that. */
  function compress(song: SongDto): void {
    markCompressing(song.id, true)
    void window.api.library
      .compress(song.id)
      .then(({ song: updated, shrank }) => {
        dispatch({ type: 'library/songUpdated', song: updated })
        dispatch({
          type: 'toast/pushed',
          message: shrank
            ? `Compressed "${updated.title}"`
            : `"${updated.title}" is already smaller than an Opus re-encode — kept the original`
        })
      })
      .catch(fail)
      .finally(() => {
        markCompressing(song.id, false)
        // `exists` is derived only main-side, so re-read to heal a row whose dto raced the swap.
        void refreshLibrary(dispatch)
      })
  }

  /** `library/songsRemoved` first — only that clears the song from history and the played set. */
  function remove(songId: string): void {
    setConfirmingId(null)
    void window.api.library
      .remove(songId)
      .then(async () => {
        dispatch({ type: 'library/songsRemoved', songIds: [songId] })
        await refreshLibrary(dispatch)
      })
      .catch((error: unknown) => {
        dispatch({ type: 'toast/pushed', message: trashFailureMessage(error) })
      })
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
                  {song.compressed || !song.exists ? null : (
                    <>
                      <button
                        type="button"
                        className="btn-grey"
                        aria-label={`Compress ${song.title}`}
                        disabled={compressing.has(song.id) || song.id === playback.currentId}
                        aria-describedby={
                          song.id === playback.currentId ? `compress-hint-${song.id}` : undefined
                        }
                        onClick={() => compress(song)}
                      >
                        Compress
                      </button>
                      {/* On the page, not in a `title`: a disabled button never announces one. */}
                      {song.id === playback.currentId ? (
                        <span className="compress-note" id={`compress-hint-${song.id}`}>
                          {HELD_BY_PLAYER}
                        </span>
                      ) : (
                        <strong className="compress-estimate">
                          {formatCompressionSaving(song.sizeBytes, song.durationSec)}
                        </strong>
                      )}
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
                  {/* Inline: there is one dialog slot, so the global confirm would close this. */}
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

        {/* Beside the label, not inside it: a figure in there would rename the preference. */}
        <div className="checkbox-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.compressByDefault}
              onChange={(event) => toggleCompress(event.target.checked)}
            />
            Compress new audios option by default
          </label>
          <span className="compress-note">
            —{' '}
            <strong className="compress-estimate">
              {formatCompressionSaving(null, undefined)}
            </strong>
          </span>
        </div>
        <p className="dialog-hint">
          Re-encodes to Opus 96k, saving space with minimal quality loss.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Ok
          </button>
        </div>
      </div>
    </div>
  )
}
