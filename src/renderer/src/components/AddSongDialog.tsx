import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import type { DownloadProgress } from '../../../shared/types'
import { refreshLibrary } from '../hooks/useApiEvents'
import { useEscapeKey } from '../hooks/useEscapeKey'
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

/** How far along in bytes — only when there is both a numerator and a denominator to show. */
function bytesLabel(progress: DownloadProgress): string | null {
  const { bytes, totalBytes } = progress
  if (bytes === undefined || totalBytes === undefined) return null
  return `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`
}

/**
 * Both ways into the library.
 *
 * A file import is one call. A URL is two steps by design — probe first so the user confirms a
 * real title and tags before yt-dlp starts pulling bytes — and stays open when it fails, because
 * the usual fix (a different URL) is right there in the form.
 *
 * Several dropped files are imported one after another: the form re-arms with the next file's name
 * instead of silently ignoring everything past the first.
 */
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
  /** A *probe* in flight, which is the one wait long enough to need explaining. */
  const [probing, setProbing] = useState(false)
  /**
   * A *download* in flight, which is narrower than `busy` and is the only thing `download.cancel()`
   * can reach. Tracked apart from `busy` because the action row swaps the close button for
   * "Cancel download": doing that for every busy state left a slow probe with no way out at all.
   */
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)

  // Subscribed for the dialog's whole life, not just while a download runs: the first progress
  // line can arrive before `start` has even resolved its promise.
  useEffect(() => window.api.download.onProgress(setProgress), [])

  // Registry order, so the same three chips always arrive in the same order.
  const chosenTags = tags.filter((tag) => picked.has(tag.name)).map((tag) => tag.name)

  const close = (): void => dispatch({ type: 'dialog/closed' })
  const fail = (error: unknown): void =>
    dispatch({ type: 'toast/pushed', message: errorMessage(error) })

  function cancelDownload(): void {
    void window.api.download.cancel().catch(fail)
  }

  // Escape does whatever the button next to it does — cancels a running download rather than
  // walking away and orphaning it, and otherwise closes.
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
        // More files were dropped or picked: re-arm the form for the next one.
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
                Choose files…
              </button>
              <p className="dialog-hint">
                {paths.length === 0
                  ? 'No file chosen yet — or drop one onto the window.'
                  : `${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ''}`}
              </p>
              <p className="dialog-hint">
                {/* The playable subset of the picker filter in main/index.ts — change them
                    together. The filter is a net and stays wider on purpose; this is a claim, and
                    the two types it drops (AIFF, WMA) have no entry in the media protocol's
                    mimeTypes because Chromium cannot decode them. */}
                Supported: MP3, M4A, AAC, FLAC, WAV, OGG, Opus.
              </p>
            </div>
          ) : (
            <div className="field">
              <label className="field">
                URL
                <input value={url} onChange={(event) => setUrl(event.target.value)} />
              </label>
              <button type="button" onClick={fetchDetails} disabled={busy || url.trim() === ''}>
                Fetch details
              </button>
              <p className="dialog-hint">
                Downloads use yt-dlp: YouTube, SoundCloud, Bandcamp and most audio and video sites
                work. Audio arrives as M4A or WebM. A playlist link fetches only the linked item —
                and &quot;Update yt-dlp&quot; in Settings refreshes which sites are supported.
              </p>
              {/*
                The bundled yt-dlp is self-extracting: its first run after launch spends half a
                minute unpacking itself, and a dialog that says nothing for thirty seconds is a
                hung one as far as anybody watching is concerned.
              */}
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
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
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

          {/*
            The estimate sits beside the label rather than inside it: the checkbox is named by its
            label, and a saving figure in there would rename the preference itself.
          */}
          <div className="checkbox-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={compress}
                onChange={(event) => setCompress(event.target.checked)}
              />
              Compress to Opus
            </label>
            <span className="compress-note">
              —{' '}
              <strong className="compress-estimate">
                {/* A URL has no size before it is downloaded, so the quote is always the generic one. */}
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
