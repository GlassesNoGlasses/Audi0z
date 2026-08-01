import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { audioDir, ensureDirs } from '../../src/main/paths'

/**
 * An isolated on-disk library for a single test: a real temp directory laid out exactly like the
 * production one (`ensureDirs` is reused so the layout can never drift).
 */
export interface TmpLibrary {
  /** Library root — pass it as `MML_LIBRARY_DIR` or straight to a store factory. */
  root: string
  /** `<root>/audio` */
  audio: string
  cleanup(): Promise<void>
}

export async function createTmpLibrary(): Promise<TmpLibrary> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mml-library-'))
  ensureDirs(root)
  return {
    root,
    audio: audioDir(root),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    }
  }
}
