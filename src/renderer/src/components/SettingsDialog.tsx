import { useMemo, useState, type ReactElement } from 'react'
import type { SongDto } from '../../../shared/types'
import { refreshLibrary } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { errorMessage, trashFailureMessage } from '../lib/errors'
import { formatBytes, formatCompressionSaving } from '../lib/format'
import { useAppDispatch, useAppState } from '../state/AppContext'

/**
 * Why the player's own song cannot be compressed.
 *
 * ffmpeg replaces the file in place, and the `<audio>` element streams it by Range request for as
 * long as the song is cued — paused included. Swapping the file underneath makes the next request
 * fail, and the app reads that failure as a file gone missing: the user would be told compression
 * lost the song. Not offering it is the cheap, deterministic way out.
 */
const HELD_BY_PLAYER = 'Loaded in the player — compressing would replace the file it is streaming'

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

  function markCompressing(songId: string, busy: boolean): void {
    setCompressing((current) => {
      const next = new Set(current)
      if (busy) next.add(songId)
      else next.delete(songId)
      return next
    })
  }

  /**
   * Resolving is not the same as having compressed. A re-encode that came out no smaller is thrown
   * away and the original kept — a real outcome with nothing to show for it, so the toast is the
   * only place the user can learn the file did not change and the row is still offering Compress.
   */
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
        // Disk truth once the dust settles, on both outcomes. `exists` is derived on the main
        // process's side of an IPC call and nowhere else, so a dto that raced the file swap and
        // came back "File missing" would sit on the row until the next restart — this is what
        // heals it, and a failed run is exactly when a row is most likely to need it.
        void refreshLibrary(dispatch)
      })
  }

  /**
   * `library/songsRemoved` first, then the re-read — the same order the song rows delete in.
   * Re-reading the library only reshapes the queue's ORDER; the history and the played flags are
   * the engine's, and only this action clears the deleted song out of them. Left there, Prev would
   * cue a song that no longer exists and quietly kill the transport.
   *
   * The failure is enriched exactly as `App.confirmIntent` enriches the song row's own delete: the
   * same refusal from the OS has to tell the user the same story from both places.
   */
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
                  {/*
                    Nothing to offer on a file that is already compressed, and nothing to offer on
                    one that is gone: ffmpeg needs a file to read, so that click could only ever
                    end in `source file not found`.
                  */}
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
                      {/*
                        The reason is on the page rather than in a `title`, which a disabled button
                        never announces and mostly never shows. It takes the estimate's slot: a
                        saving quoted for a file you cannot compress right now was noise anyway.
                      */}
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
          Compression re-encodes to Opus 96k on the way in. It saves space and loses a little
          quality.
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
