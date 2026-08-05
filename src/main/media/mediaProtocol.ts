import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Song } from '../../shared/types'
import { contentTypeFor } from './mimeTypes'

/**
 * The `media://audio/<id>` handler.
 *
 * Audio is served over a custom protocol rather than `file://` so the renderer never learns a real
 * path and cannot read anything outside the library. Range support is what makes `<audio>` seek
 * without downloading the whole file, so it is implemented properly: 206 with a `Content-Range`,
 * 416 for a start past the end, plain 200 when the client asks for everything.
 *
 * The factory is exported on its own — wiring it into `protocol.handle` needs electron, and this
 * module deliberately does not.
 */

export interface RangeSpec {
  start: number
  end: number
}

/** `null` means "no usable Range header" — the caller answers 200 with the whole file. */
export type ParsedRange = RangeSpec | 'unsatisfiable' | null

/** A single byte range. Multi-range requests are deliberately unsupported (Chromium never sends one). */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

export function parseRangeHeader(header: string | null, size: number): ParsedRange {
  if (!header) return null
  const match = RANGE_PATTERN.exec(header.replace(/\s+/g, ''))
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    // Suffix form (`bytes=-500`): the last N bytes of the file.
    const suffix = Number(rawEnd)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (size === 0 || start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  // A backwards range is malformed rather than unsatisfiable: RFC 9110 says ignore it.
  if (end < start) return null
  return { start, end }
}

/**
 * Joins `fileName` onto the audio directory and refuses anything that resolves outside it.
 *
 * `fileName` comes from `library.json`, which a user can hand-edit — `../../…` must never reach
 * the filesystem.
 */
export function resolveAudioPath(audioDir: string, fileName: string): string | null {
  const base = path.resolve(audioDir)
  const resolved = path.resolve(base, fileName)
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`
  return resolved.startsWith(prefix) ? resolved : null
}

export interface MediaFs {
  stat(filePath: string): Promise<{ size: number }>
  createReadStream(filePath: string, options: { start: number; end: number }): Readable
}

export interface MediaHandlerDeps {
  /** Usually `libraryStore.getSong` — called on every Range request, so it must be cheap. */
  getSong(id: string): Promise<Song | undefined>
  audioDir: string
  /**
   * Usually `compressionJobs.waitFor`. Absent means nothing is tracking compressions; an undefined
   * return means this song has none in flight.
   */
  awaitCompression?: (id: string) => Promise<void> | undefined
  /** Injected by tests; defaults to the real filesystem. */
  fs?: MediaFs
}

const nodeFs: MediaFs = {
  stat: (filePath) => stat(filePath),
  createReadStream: (filePath, options) => createReadStream(filePath, options)
}

/** Everything the renderer is not allowed to distinguish collapses to a bare 404. */
function notFound(): Response {
  return new Response(null, { status: 404 })
}

function songIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.hostname !== 'audio') return null
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    return id === '' || id.includes('/') ? null : id
  } catch {
    return null
  }
}

export function createMediaHandler(
  deps: MediaHandlerDeps
): (request: Request) => Promise<Response> {
  const fs = deps.fs ?? nodeFs

  return async function handleMediaRequest(request: Request): Promise<Response> {
    const id = songIdFromUrl(request.url)
    if (id === null) return notFound()

    // A compression in flight is about to swap this very file; wait it out and read the record
    // fresh. When nothing is in flight this is not even a microtask.
    const compressing = deps.awaitCompression?.(id)
    if (compressing) await compressing

    let song: Song | undefined
    try {
      song = await deps.getSong(id)
    } catch {
      return notFound()
    }
    if (!song) return notFound()

    const filePath = resolveAudioPath(deps.audioDir, song.fileName)
    if (filePath === null) return notFound()

    let size: number
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      return notFound()
    }

    const range = parseRangeHeader(request.headers.get('Range'), size)
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` }
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : Math.max(size - 1, 0)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': contentTypeFor(song.fileName),
      'Content-Length': String(size === 0 ? 0 : end - start + 1)
    })
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)

    const stream = fs.createReadStream(filePath, { start, end })
    // Scrubbing an <audio> element cancels the in-flight request every few milliseconds; without
    // this the descriptors pile up until the process runs out of them.
    abortWith(request.signal, stream)

    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers
    })
  }
}

function abortWith(signal: AbortSignal, stream: Readable): void {
  if (signal.aborted) {
    stream.destroy()
    return
  }
  const onAbort = (): void => {
    stream.destroy()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  stream.once('close', () => {
    signal.removeEventListener('abort', onAbort)
  })
}
