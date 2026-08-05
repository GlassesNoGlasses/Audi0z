/**
 * The main process's memory of which songs are mid-compression. The media protocol asks it before
 * serving a file: a request that raced an in-flight transcode waits for the settle and then reads
 * the record fresh, instead of streaming a file that is about to be swapped out underneath it —
 * the renderer would read that mid-stream swap as the file having gone missing.
 *
 * Failure is deliberately not interesting to a waiter: a failed compression leaves the original
 * file in place (the `.part` staging never touches it), so "settled" is all a reader needs.
 */
export interface CompressionJobs {
  /** Run `job` as the tracked compression of `id`; the entry clears itself on settle. */
  run<T>(id: string, job: () => Promise<T>): Promise<T>
  /**
   * Undefined when `id` has no compression in flight — the caller skips the await entirely, so an
   * idle library pays nothing.
   */
  waitFor(id: string): Promise<void> | undefined
}

export function createCompressionJobs(): CompressionJobs {
  const jobs = new Map<string, Promise<void>>()
  return {
    run(id, job) {
      const promise = job()
      // The tracked promise absorbs the outcome instead of forwarding it. Waiters only need to
      // know the file stopped moving, and a derived promise that inherited the rejection would
      // have nobody to handle it — a failed compression would surface as an unhandled rejection
      // in the main process, which is the caller's error to report, not ours to duplicate.
      const settled = promise.then(
        () => undefined,
        () => undefined
      )
      jobs.set(id, settled)
      void settled.then(() => {
        // Only if the slot is still this job's: a second compression of the same song owns it now,
        // and clearing that entry would let a reader through mid-transcode.
        if (jobs.get(id) === settled) jobs.delete(id)
      })
      return promise
    },
    waitFor(id) {
      return jobs.get(id)
    }
  }
}
