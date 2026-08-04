import { describe, expect, it } from 'vitest'
import { createCompressionJobs } from './compressionJobs'

describe('createCompressionJobs', () => {
  /** Tracking is a side channel: the caller must get the same promise it would have gotten. */
  it('passes the job result and rejection through untouched', async () => {
    const jobs = createCompressionJobs()
    await expect(jobs.run('a', async () => 'done')).resolves.toBe('done')
    await expect(jobs.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    )
  })

  it('answers immediately for a song that was never compressing', async () => {
    await expect(createCompressionJobs().waitFor('a')).resolves.toBeUndefined()
  })

  /**
   * The whole point of the module: a reader that arrives mid-transcode is parked until the file
   * stops moving. A failure releases it just the same — the original file is still there, so
   * "settled" is all a waiter needs, and a waiter must never inherit the job's rejection.
   */
  it('holds a waiter until the in-flight job settles, success or failure', async () => {
    const jobs = createCompressionJobs()

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const running = jobs.run('a', () => gate)
    let waited = false
    const waiter = jobs.waitFor('a').then(() => (waited = true))
    await Promise.resolve()
    expect(waited).toBe(false)
    release()
    await running
    await waiter
    expect(waited).toBe(true)

    let fail!: (error: Error) => void
    const failing = new Promise<void>((_resolve, reject) => (fail = reject))
    const losing = jobs.run('b', () => failing)
    let waitedOutFailure = false
    const failureWaiter = jobs.waitFor('b').then(() => (waitedOutFailure = true))
    await Promise.resolve()
    expect(waitedOutFailure).toBe(false)
    fail(new Error('ffmpeg died'))
    await expect(losing).rejects.toThrow('ffmpeg died')
    await failureWaiter
    expect(waitedOutFailure).toBe(true)
  })

  /** An entry that outlived its job would park every later request on that song forever. */
  it('forgets the job once it settles', async () => {
    const jobs = createCompressionJobs()
    await jobs.run('a', async () => 'done')
    await expect(jobs.waitFor('a')).resolves.toBeUndefined()
  })
})
