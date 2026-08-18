
export interface CompressionJobs {
  run<T>(id: string, job: () => Promise<T>): Promise<T>
  waitFor(id: string): Promise<void> | undefined
}

// Compression jobs handler for audio files with listeners
export function createCompressionJobs(): CompressionJobs {
  const jobs = new Map<string, Promise<void>>()
  return {
    run(id, job) {
      const promise = job()
      const settled = promise.then(
        () => undefined,
        () => undefined
      )
      jobs.set(id, settled)
      void settled.then(() => {
        if (jobs.get(id) === settled) jobs.delete(id)
      })
      return promise
    },
    waitFor(id) {
      return jobs.get(id)
    }
  }
}
