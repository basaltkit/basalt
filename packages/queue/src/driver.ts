export interface AddJobOptions {
  attempts: number
  backoff?: { type: 'exponential' | 'fixed'; delayMs: number } | undefined
  delayMs?: number | undefined
  priority?: number | undefined
}

export type JobExecutor = (jobName: string, data: unknown) => Promise<void>

/** Queue driver contract. BullMQ in production; sync in tests/dev. */
export interface QueueDriver {
  /** Called once by the QueueManager — how to execute a received job. */
  setExecutor(executor: JobExecutor): void
  add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void>
  /** Starts a worker for the queue (no-op in the sync driver: add executes inline). */
  startWorker(queue: string, options?: { concurrency?: number }): void
  close(): Promise<void>
}
