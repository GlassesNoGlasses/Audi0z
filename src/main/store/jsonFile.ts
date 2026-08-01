import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delayMs } from 'node:timers/promises'

/**
 * Crash-safe JSON persistence: the one place in the app that touches `library.json`,
 * `playlists.json` and `settings.json`.
 *
 * Two guarantees the stores rely on:
 *   - a read never throws on a corrupt file — the bad bytes are quarantined to `<file>.bak` and
 *     the caller gets its default, so a hand-edited library cannot brick the app;
 *   - a write is atomic (temp file -> fsync -> rename) and writes to the same path are serialised,
 *     so a reader always sees either the previous or the next complete document, never a torn one.
 *
 * No `electron` import: the stores are constructed with an explicit directory and unit-tested in a
 * plain node process.
 */

/** How long to wait before the single rename retry (Windows AV briefly locks the target). */
export const RENAME_RETRY_DELAY_MS = 50

export interface RenameOps {
  rename(from: string, to: string): Promise<void>
  delay(ms: number): Promise<void>
}

const defaultRenameOps: RenameOps = {
  rename: (from, to) => rename(from, to),
  delay: async (ms) => {
    await delayMs(ms)
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/**
 * Exported for its own test: `rename` over an existing file can fail with `EPERM` on Windows when
 * an antivirus scanner holds the target open for a moment. One retry clears it in practice.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  ops: RenameOps = defaultRenameOps
): Promise<void> {
  try {
    await ops.rename(from, to)
  } catch (error) {
    if (errorCode(error) !== 'EPERM') throw error
    await ops.delay(RENAME_RETRY_DELAY_MS)
    await ops.rename(from, to)
  }
}

/**
 * Reads and validates a JSON document.
 *
 * Missing file -> `makeDefault()` and nothing is written (an empty library is not worth a file
 * until something is actually added). Unparsable or structurally wrong -> the original bytes are
 * copied to `<filePath>.bak` and `makeDefault()` is returned; the original is left in place too,
 * so nothing is ever lost silently.
 */
export async function readJsonFile<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
  makeDefault: () => T
): Promise<T> {
  let raw: Buffer
  try {
    raw = await readFile(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return makeDefault()
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    await quarantine(filePath, raw)
    return makeDefault()
  }

  if (!validate(parsed)) {
    await quarantine(filePath, raw)
    return makeDefault()
  }
  return parsed
}

async function quarantine(filePath: string, raw: Buffer): Promise<void> {
  await writeFile(`${filePath}.bak`, raw)
}

/**
 * Serialises `data` and replaces `filePath` atomically.
 *
 * Concurrent calls for the same path queue behind each other (last caller wins) so two stores
 * flushing at once cannot interleave; different paths proceed in parallel.
 */
export function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const key = path.resolve(filePath)
  const queued = (chains.get(key) ?? Promise.resolve()).then(() => writeNow(filePath, data))
  chains.set(
    key,
    queued.then(
      () => undefined,
      () => undefined
    )
  )
  return queued
}

/** One promise chain per resolved path — three entries in practice, so it is never pruned. */
const chains = new Map<string, Promise<void>>()

async function writeNow(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`
  try {
    const json = `${JSON.stringify(data, null, 2)}\n`
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(json, 'utf8')
      // fsync before the rename: a rename of an unflushed file can survive a crash as a
      // zero-length library.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true })
    throw error
  }
}
