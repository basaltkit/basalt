import type { AddJobOptions, JobExecutor, QueueDriver } from '../driver.js'

/** `executed[]` keeps at most this many entries (oldest evicted first). */
const EXECUTED_HISTORY_LIMIT = 1000

/**
 * Synchronous driver: executes the job inline on dispatch, honoring `attempts`
 * (immediate retry). It is the driver for tests and Redis-less dev — the
 * equivalent of Laravel's `sync` queue driver.
 *
 * Semantics to be aware of (they differ from a broker-backed driver):
 * - **At-most-once.** A job that exhausts its inline retries is LOST — there is
 *   no persistence and no later redelivery.
 * - **Errors propagate to the dispatcher.** `job.dispatch()` rejects when the
 *   handler fails (useful in tests/dev; a broker driver would return
 *   immediately and retry in the background).
 * Deploying this driver to production is almost always a misconfiguration —
 * `queuePlugin` warns when it is selected by default there.
 */
export class SyncQueueDriver implements QueueDriver {
  readonly name = 'sync'
  // Runs inline on dispatch: retries are honored (immediately), but there is no
  // deferred delivery and no ordering, so delayed/priority are not supported.
  readonly capabilities = { delayed: false, priority: false, retries: true, backoff: false }
  private executor: JobExecutor | undefined
  /** execution history — useful in test assertions */
  readonly executed: { queue: string; jobName: string; attempts: number }[] = []

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      try {
        await this.executor?.(jobName, data)
        this.record({ queue, jobName, attempts: attempt })
        return
      } catch (error) {
        lastError = error
      }
    }
    this.record({ queue, jobName, attempts: options.attempts })
    throw lastError
  }

  startWorker(): void {
    // no-op: add() already executes inline
  }

  /** Appends to `executed[]`, evicting the oldest entries past the cap so a
   * long-running process on this driver cannot leak memory unboundedly. */
  private record(entry: { queue: string; jobName: string; attempts: number }): void {
    this.executed.push(entry)
    if (this.executed.length > EXECUTED_HISTORY_LIMIT) {
      this.executed.splice(0, this.executed.length - EXECUTED_HISTORY_LIMIT)
    }
  }

  async close(): Promise<void> {}
}
