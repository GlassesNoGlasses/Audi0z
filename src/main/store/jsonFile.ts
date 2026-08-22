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

/** Reads and validates JSON; bad bytes go to `<filePath>.bak` and `makeDefault()` is returned. */
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

/** Puts unreadable bytes aside as `<filePath>.bak`, overwritten on each failed read. */
async function quarantine(filePath: string, raw: Buffer): Promise<void> {
  await writeFile(`${filePath}.bak`, raw)
}

/** Memoises the first successful `read()` in memory; a rejection is not cached. */
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

/** Serialises store mutators: one entering another's disk-await window reads unadopted state. */
export function createMutatorLock(): <A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
) => (...args: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve()
  return (fn) =>
    (...args) => {
      const result = chain.then(
        () => fn(...args),
        () => fn(...args)
      )
      chain = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
}

/** One promise chain per resolved path. Last caller wins. */
const chains = new Map<string, Promise<void>>()

/** Serialises `data` and atomically replaces `filePath`; same-path writes queue up. */
export function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  // Stringified at enqueue: later mutation of a caller's live array can't rewrite a queued payload.
  let json: string
  try {
    json = `${JSON.stringify(data, null, 2)}\n`
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  const key = path.resolve(filePath)
  const queued = (chains.get(key) ?? Promise.resolve()).then(() => writeNow(filePath, json))
  chains.set(
    key,
    queued.then(
      () => undefined,
      () => undefined
    )
  )
  return queued
}

/** Writes `json` to a temp file, syncs, then renames it over `filePath`; temp always removed. */
async function writeNow(filePath: string, json: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`
  try {
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(json, 'utf8')
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
