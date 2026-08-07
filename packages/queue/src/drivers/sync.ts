import type { AddJobOptions, JobExecutor, QueueDriver } from '../driver.js'

/**
 * Synchronous driver: executes the job inline on dispatch, honoring `attempts`
 * (immediate retry). It is the driver for tests and Redis-less dev — the
 * equivalent of Laravel's `sync` queue driver.
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
        this.executed.push({ queue, jobName, attempts: attempt })
        return
      } catch (error) {
        lastError = error
      }
    }
    this.executed.push({ queue, jobName, attempts: options.attempts })
    throw lastError
  }

  startWorker(): void {
    // no-op: add() already executes inline
  }

  async close(): Promise<void> {}
}
