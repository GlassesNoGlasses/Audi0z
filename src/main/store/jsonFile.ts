import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delayMs } from 'node:timers/promises'

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

// Because Windows AV is a pain.
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
 * Reads, validates and returns a JSON document. Errors are quarantined in a `<filePath>.bak` file,
 * with `makeDefault()` being returned.
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

/**
 * Puts the unreadable bytes aside from a failed read. File is stored as `<filePath>.bak`, and
 * is overwritten in each failed read to the same file path. Use for potential restore and backup.
 */
async function quarantine(filePath: string, raw: Buffer): Promise<void> {
  await writeFile(`${filePath}.bak`, raw)
}

/** Reads a file and loads the content into memory. Call using await on the promise. */
export function loadOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let value: T | null = null
  let pending: Promise<T> | null = null

  return async function loaded(): Promise<T> {
    if (value !== null) return value
    if (pending === null) {
      pending = read()
      void pending.catch(() => {
        pending = null
      })
    }
    const result = await pending
    if (value === null) value = result
    return value
  }
}

/** One promise chain per resolved path used in `writeJsonFile`. Last caller wins.  */
const chains = new Map<string, Promise<void>>()

/**
 * Serialises `data` and replaces `filePath` atomically.
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

/** 
 * Writes to `filePath` JSON data `data`. A temp file is used first, with syncing and renaming 
 * performed on success; temp file is always removed.
*/
async function writeNow(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`
  try {
    const json = `${JSON.stringify(data, null, 2)}\n`
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(json, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }) // remove temp file
    throw error
  }
}
