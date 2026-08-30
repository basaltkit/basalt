import type { RequestContext } from '@basaltkit/core'

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

/** Job counts per state, for `basalt queue:stats`. */
export interface QueueStats {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/**
 * Driver-neutral job state — deliberately the same vocabulary as
 * {@link QueueStats}, so `stats()` and `list()` describe the same lifecycle.
 * Backend-specific states are mapped onto these by the driver.
 */
export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'

/**
 * States {@link QueueDriver.list} returns when the caller picks none.
 *
 * `completed` and `failed` come FIRST and are included on purpose: a worker
 * drains `waiting` in milliseconds, so a healthy queue has `waiting: 0,
 * active: 0` nearly always. Defaulting to only those would answer "did my job
 * run?" with an empty list on a queue that is working perfectly — the classic
 * false alarm. `delayed` is left out of the default (it is a deliberate,
 * separate question); ask for it explicitly.
 */
export const DEFAULT_LIST_STATES: readonly JobState[] = ['completed', 'failed', 'waiting', 'active']

/** Default `limit` for {@link QueueDriver.list} — a screenful, not a dump. */
export const DEFAULT_LIST_LIMIT = 20

/** Hard ceiling on `limit`, so an inspection call can't turn into a full scan. */
export const MAX_LIST_LIMIT = 1000

export interface ListJobsOptions {
  /** States to look in. Default {@link DEFAULT_LIST_STATES}. */
  states?: JobState[] | undefined
  /**
   * Maximum jobs returned in TOTAL (newest first), not per state. Default
   * {@link DEFAULT_LIST_LIMIT}, capped at {@link MAX_LIST_LIMIT}.
   */
  limit?: number | undefined
}

/**
 * A driver-neutral view of ONE job. Drivers must return this — never their
 * backend's own job object (a BullMQ `Job`, an amqplib message, …). Leaking
 * that would invert the coupling this API exists to remove: the app would be
 * back to writing broker-specific code, just through a Basalt method.
 */
export interface JobSummary {
  /** Backend-assigned job id, as a string. */
  id: string
  /** The job name — what `defineJob({ name })` declared. */
  name: string
  /** Which state the job was found in. */
  state: JobState
  /** Attempts made so far (0 before the first run). */
  attemptsMade: number
  /** When the job was created, epoch milliseconds. */
  timestamp: number
  /** The APP's payload — unwrapped from the dispatch envelope. */
  payload: unknown
  /** The request context captured at dispatch (requestId, tenantId, …), if any. */
  context?: RequestContext | undefined
  /** Why it failed — only meaningful for `state: 'failed'`. */
  failedReason?: string | undefined
}

/**
 * The wire shape `QueueManager.dispatch` hands to {@link QueueDriver.add} as
 * `data`: the app's payload plus a snapshot of the request context, so the
 * context survives the hop to the worker. Drivers store it opaquely; only
 * `list()` needs to open it — via {@link readJobEnvelope}.
 */
export interface JobEnvelope {
  payload: unknown
  context?: RequestContext | undefined
}

/**
 * Opens a dispatch envelope for {@link JobSummary}. Defensive on purpose: a
 * queue can also hold data written by an older version or by a non-Basalt
 * producer, and an inspection command must never throw on it — anything that
 * is not an envelope is reported as the payload itself.
 */
export function readJobEnvelope(data: unknown): {
  payload: unknown
  context?: RequestContext | undefined
} {
  if (typeof data === 'object' && data !== null && 'payload' in data) {
    const envelope = data as JobEnvelope
    return {
      payload: envelope.payload,
      ...(envelope.context !== undefined ? { context: envelope.context } : {}),
    }
  }
  return { payload: data }
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
  /**
   * Optional: job counts per state, for `basalt queue:stats`. Backends that
   * cannot introspect (e.g. the inline sync driver) omit it — the CLI then
   * reports the operation as unsupported rather than guessing.
   */
  stats?(queue: string): Promise<QueueStats>
  /**
   * Optional: re-enqueue failed jobs (`basalt queue:retry`). Returns how many
   * were retried. `limit` caps how many are processed (default driver's choice).
   */
  retryFailed?(queue: string, options?: { limit?: number }): Promise<number>
  /**
   * Optional: list individual jobs (`basalt queue:jobs`) as driver-neutral
   * {@link JobSummary} objects — newest first, `payload` unwrapped from the
   * dispatch envelope via {@link readJobEnvelope}.
   *
   * Omit it when the backend cannot read a job WITHOUT consuming it: faking
   * the capability with a destructive read (an AMQP `basic.get`, an SQS
   * `ReceiveMessage`) would make merely *looking* at a queue change it. The
   * QueueManager then returns `undefined` and the CLI reports the operation as
   * unsupported — an honest gap beats a dangerous guess.
   */
  list?(queue: string, options?: ListJobsOptions): Promise<JobSummary[]>
  close(): Promise<void>
}
