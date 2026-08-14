/** Driver-neutral retention: `true`/`false`, a count, or `{ ageMs, count }`. */
export type RetentionOption = boolean | number | { ageMs?: number; count?: number }

export interface AddJobOptions {
  attempts: number
  backoff?: { type: 'exponential' | 'fixed'; delayMs: number } | undefined
  delayMs?: number | undefined
  priority?: number | undefined
  /** Retention for completed jobs. Undefined → the driver's default. */
  removeOnComplete?: RetentionOption | undefined
  /** Retention for failed jobs. Undefined → the driver's default. */
  removeOnFail?: RetentionOption | undefined
}

export type JobExecutor = (jobName: string, data: unknown) => Promise<void>

/**
 * What a driver's backend honors. Backends differ: RabbitMQ needs a
 * dead-letter setup for delayed jobs, Kafka has no message priority, etc. The
 * QueueManager checks a dispatch's options against these and reacts per the
 * `onUnsupported` policy instead of silently dropping them. A driver that omits
 * `capabilities` is assumed fully capable (back-compat for existing drivers).
 */
export interface DriverCapabilities {
  /** Honors delayed delivery (`delay`). */
  delayed: boolean
  /** Honors message priority. */
  priority: boolean
  /** Re-runs a failed job up to `attempts` times. */
  retries: boolean
  /** Waits `backoff` between retries (vs retrying immediately). */
  backoff: boolean
}

/** Queue driver contract. BullMQ in production; sync in tests/dev. */
export interface QueueDriver {
  /** Short identifier used in diagnostics (e.g. 'bullmq', 'sync'). */
  readonly name?: string
  /** What this backend honors — see {@link DriverCapabilities}. */
  readonly capabilities?: DriverCapabilities
  /** Called once by the QueueManager — how to execute a received job. */
  setExecutor(executor: JobExecutor): void
  add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void>
  /** Starts a worker for the queue (no-op in the sync driver: add executes inline). */
  startWorker(queue: string, options?: { concurrency?: number }): void
  close(): Promise<void>
}
