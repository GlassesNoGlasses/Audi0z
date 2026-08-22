import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { AUDIO_FORMAT_LABELS } from '../../../shared/audioFormats'
import type { DownloadProgress } from '../../../shared/types'
import { refreshLibrary } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useToastError } from '../hooks/useToastError'
import { errorMessage, isBusy, isCancelled } from '../lib/errors'
import { formatBytes, formatCompressionSaving } from '../lib/format'
import { titleFromPath } from '../lib/text'
import { useAppDispatch, useAppState } from '../state/AppContext'
import type { AddSource } from '../state/appReducer'

export interface AddSongDialogProps {
  source: AddSource
}

function stageLabel(progress: DownloadProgress): string {
  const percent = progress.percent === null ? '' : ` ${progress.percent}%`
  switch (progress.stage) {
    case 'downloading':
      return `Downloading…${percent}`
    case 'transcoding':
      return `Compressing…${percent}`
    case 'saving':
      return `Saving…${percent}`
  }
}

function bytesLabel(progress: DownloadProgress): string | null {
  const { bytes, totalBytes } = progress
  if (bytes === undefined || totalBytes === undefined) return null
  return `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`
}

/** Both ways in: files (one call each, the form re-arms) and a URL (probe first, then download). */
export function AddSongDialog({ source }: AddSongDialogProps): ReactElement {
  const { settings, tags } = useAppState()
  const dispatch = useAppDispatch()

  const [mode, setMode] = useState<'files' | 'url'>(source.kind === 'url' ? 'url' : 'files')
  const [paths, setPaths] = useState<string[]>(source.kind === 'files' ? source.paths : [])
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState(
    source.kind === 'files' && source.paths.length > 0 ? titleFromPath(source.paths[0]) : ''
  )
  /** Registry names, not free text: this dialog picks from the tags that exist, it never adds one. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [compress, setCompress] = useState(settings.compressByDefault)
  /** Anything in flight: the form must not be submitted twice or edited out from under a request. */
  const [busy, setBusy] = useState(false)
  /** A probe in flight — the one wait long enough to need explaining. */
  const [probing, setProbing] = useState(false)
  /** A download in flight — narrower than `busy`; only this swaps in the Cancel download button. */
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  // Subscribed for the dialog's whole life: the first progress line can beat `start`'s promise.
  useEffect(() => window.api.download.onProgress(setProgress), [])

  // Registry order, so the chips always arrive in the same order.
  const chosenTags = tags.filter((tag) => picked.has(tag.name)).map((tag) => tag.name)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  const fail = useToastError()

  function cancelDownload(): void {
    void window.api.download.cancel().catch(fail)
  }

  // Escape cancels a running download rather than orphaning it, and otherwise closes.
  useEscapeKey(() => (downloading ? cancelDownload() : close()))

  function toggleTag(name: string): void {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }

  function chooseFiles(): void {
    setBusy(true)
    void window.api.files
      .pickAudioFiles()
      .then((chosen) => {
        if (chosen.length === 0) return
        setPaths(chosen)
        setTitle(titleFromPath(chosen[0]))
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  function fetchDetails(): void {
    setBusy(true)
    setProbing(true)
    void window.api.download
      .probe(url.trim())
      .then((result) => {
        setTitle(result.title)
      })
      .catch(fail)
      .finally(() => {
        setBusy(false)
        setProbing(false)
      })
  }

  function addFile(): void {
    const [sourcePath, ...rest] = paths
    setBusy(true)
    void window.api.library
      .add({ sourcePath, title: title.trim(), tags: chosenTags, compress })
      .then(async () => {
        await refreshLibrary(dispatch)
        if (rest.length === 0) {
          close()
          return
        }
        setPaths(rest)
        setTitle(titleFromPath(rest[0]))
        setPicked(new Set())
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  function download(): void {
    setBusy(true)
    setDownloading(true)
    setProgress(null)
    void window.api.download
      .start({ url: url.trim(), title: title.trim(), tags: chosenTags, compress })
      .then(async () => {
        await refreshLibrary(dispatch)
        close()
      })
      .catch((error: unknown) => {
        // A cancel is the user's own doing, so it is not reported as a failure.
        if (isCancelled(error)) return
        dispatch({
          type: 'toast/pushed',
          message: isBusy(error)
            ? 'A download is already running — wait for it to finish, or cancel it.'
            : errorMessage(error)
        })
      })
      .finally(() => {
        setBusy(false)
        setDownloading(false)
        setProgress(null)
      })
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (mode === 'url') download()
    else addFile()
  }

  const canSubmit =
    !busy && title.trim() !== '' && (mode === 'url' ? url.trim() !== '' : paths.length > 0)

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Add song">
        <h2>Add song</h2>
        <div className="segmented">
          <button
            type="button"
            aria-pressed={mode === 'files'}
            onClick={() => setMode('files')}
            disabled={busy}
          >
            From file
          </button>
          <button
            type="button"
            aria-pressed={mode === 'url'}
            onClick={() => setMode('url')}
            disabled={busy}
          >
            From URL
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'files' ? (
            <div className="field">
              <button type="button" onClick={chooseFiles} disabled={busy}>
                Add Files Here…
              </button>
              <p className="dialog-hint">
                {paths.length >= 1 &&
                  `${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ''}`}
              </p>
              {/* The picker's own filter, read out loud — both come from the shared catalogue. */}
              <p className="dialog-hint">Supported: {AUDIO_FORMAT_LABELS.join(', ')}.</p>
            </div>
          ) : (
            <div className="field">
              <label className="field">
                URL
                <input
                  type="text"
                  placeholder="www.youtube.com/watch?v=..."
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <button type="button" onClick={fetchDetails} disabled={busy || url.trim() === ''}>
                Fetch Title
              </button>
              <p className="dialog-hint">
                Downloads via yt-dlp: YouTube, SoundCloud, Bandcamp and most audio and video sites
                work.
              </p>
              {probing ? (
                <p className="dialog-hint hint-busy">
                  <span className="spinner" aria-hidden />
                  Fetching details… (the first fetch after launch can take ~30s)
                </p>
              ) : null}
            </div>
          )}

          <label className="field">
            Title
            <input
              type="text"
              placeholder="Brainrot.exe"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <div className="field">
            <span>Tags</span>
            {tags.length === 0 ? (
              <p className="dialog-hint">No tags yet — create them from the Tags button.</p>
            ) : (
              <div className="tag-picker" role="group" aria-label="Tags">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={picked.has(tag.name)}
                    onClick={() => toggleTag(tag.name)}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Beside the label, not inside it: a figure in there would rename the preference. */}
          <div className="checkbox-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={compress}
                onChange={(event) => setCompress(event.target.checked)}
              />
              Compress to Opus format
            </label>
            <span className="compress-note">
              —{' '}
              <strong className="compress-estimate">
                {formatCompressionSaving(null, undefined)}
              </strong>
            </span>
          </div>

          {progress ? (
            <div className="download-progress">
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(progress.percent === null ? {} : { 'aria-valuenow': progress.percent })}
              >
                {/* Saving and transcoding report no percentage: the bar slides instead of filling. */}
                <div
                  className={`progress-fill${progress.percent === null ? ' progress-indeterminate' : ''}`}
                  style={progress.percent === null ? undefined : { width: `${progress.percent}%` }}
                />
              </div>
              <span className="download-label">
                <span className="spinner" aria-hidden />
                <span>{stageLabel(progress)}</span>
                {bytesLabel(progress) === null ? null : (
                  <span className="download-bytes">{bytesLabel(progress)}</span>
                )}
              </span>
            </div>
          ) : null}

          <div className="dialog-actions">
            {downloading ? (
              <button type="button" onClick={cancelDownload}>
                Cancel download
              </button>
            ) : (
              <button type="button" onClick={close}>
                Cancel
              </button>
            )}
            <button type="submit" disabled={!canSubmit}>
              {mode === 'url' ? 'Download' : 'Add to library'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
