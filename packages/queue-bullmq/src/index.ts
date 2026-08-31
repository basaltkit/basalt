// A STATIC import of the client is deliberate here, and is the one shape
// `@basaltkit/queue` itself must never have. This package exists only to bind
// BullMQ: `bullmq` is a REQUIRED peer, so a consumer who installed
// `@basaltkit/queue-bullmq` asked for it by name. The alternative — a lazy
// `await import()` like the rabbitmq/sqs/kafka satellites use — would force
// `startWorker` (a `void` method on the driver contract, which cannot await)
// into fire-and-forget async. See the carve-out in
// `packages/queue/tests/driver-boundary.test.ts`, which enforces exactly this.
import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_STATES,
  MAX_LIST_LIMIT,
  queuePlugin,
  readJobEnvelope,
  type AddJobOptions,
  type JobExecutor,
  type JobState,
  type JobSummary,
  type ListJobsOptions,
  type QueueDriver,
  type QueuePluginOptions,
  type QueueStats,
  type RetentionOption,
} from '@basaltkit/queue'

type KeepJobs = { age?: number; count?: number }

/** Map the driver-neutral retention to BullMQ's (age in seconds), falling back to a default. */
function toBullRetention(retention: RetentionOption | undefined, fallback: boolean | KeepJobs): boolean | number | KeepJobs {
  if (retention === undefined) return fallback
  if (typeof retention === 'boolean' || typeof retention === 'number') return retention
  const out: KeepJobs = {}
  if (retention.ageMs !== undefined) out.age = Math.max(1, Math.round(retention.ageMs / 1000))
  if (retention.count !== undefined) out.count = retention.count
  return out
}

export interface BullmqDriverOptions {
  /** Redis URL (redis://... or rediss://...) or ioredis connection options. */
  connection: string | ConnectionOptions
  /**
   * Infra errors from BullMQ's Worker/Queue emitters (e.g. Redis down). BullMQ
   * emits these as EventEmitter 'error' events — unhandled, they CRASH the
   * process. Default: logged via console.error with full context — observable,
   * never fatal, never silent. (Same pattern as realtime's onBridgeError.)
   */
  onError?: (error: unknown, info: { queue: string; source: 'worker' | 'queue' }) => void
  /**
   * A job exhausted its retries (BullMQ 'failed'). Default: console.error —
   * without this, exhausted jobs were only visible by polling queue stats.
   */
  onJobFailed?: (info: { queue: string; job: string; jobId?: string; error: unknown }) => void
}

export class BullmqQueueDriver implements QueueDriver {
  readonly name = 'bullmq'
  readonly capabilities = { delayed: true, priority: true, retries: true, backoff: true }
  private readonly connection: ConnectionOptions
  private readonly queues = new Map<string, Queue>()
  private readonly workers: Worker[] = []
  private executor: JobExecutor | undefined

  private readonly onError: NonNullable<BullmqDriverOptions['onError']>
  private readonly onJobFailed: NonNullable<BullmqDriverOptions['onJobFailed']>

  constructor(options: BullmqDriverOptions) {
    this.connection =
      typeof options.connection === 'string'
        ? parseRedisUrl(options.connection)
        : options.connection
    this.onError =
      options.onError ??
      ((error, info) => console.error(`[basalt:queue] bullmq ${info.source} error (queue "${info.queue}"):`, error))
    this.onJobFailed =
      options.onJobFailed ??
      ((info) =>
        console.error(
          `[basalt:queue] job "${info.job}"${info.jobId ? ` (id ${info.jobId})` : ''} on queue "${info.queue}" failed permanently:`,
          info.error,
        ))
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    await this.queue(queue).add(jobName, data, {
      attempts: options.attempts,
      ...(options.backoff
        ? { backoff: { type: options.backoff.type, delay: options.backoff.delayMs } }
        : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      removeOnComplete: toBullRetention(options.removeOnComplete, { count: 1000 }) as NonNullable<
        JobsOptions['removeOnComplete']
      >,
      removeOnFail: toBullRetention(options.removeOnFail, false) as NonNullable<JobsOptions['removeOnFail']>,
    })
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    const worker = new Worker(queue, async (job) => this.executor?.(job.name, job.data), {
      connection: this.connection,
      concurrency: options.concurrency ?? 1,
    })
    // Without these listeners an emitted 'error' crashes the process (Node
    // EventEmitter semantics) and exhausted jobs fail invisibly (Q-2).
    worker.on('error', (error) => this.onError(error, { queue, source: 'worker' }))
    worker.on('failed', (job, error) =>
      this.onJobFailed({
        queue,
        job: job?.name ?? '(unknown)',
        ...(job?.id !== undefined ? { jobId: String(job.id) } : {}),
        error,
      }),
    )
    this.workers.push(worker)
  }

  async stats(queue: string): Promise<QueueStats> {
    const c = await this.queue(queue).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    return {
      waiting: c['waiting'] ?? 0,
      active: c['active'] ?? 0,
      completed: c['completed'] ?? 0,
      failed: c['failed'] ?? 0,
      delayed: c['delayed'] ?? 0,
    }
  }

  async retryFailed(queue: string, options: { limit?: number } = {}): Promise<number> {
    const limit = options.limit ?? 1000
    const failed = await this.queue(queue).getFailed(0, limit - 1)
    let retried = 0
    for (const job of failed) {
      await job.retry()
      retried++
    }
    return retried
  }

  /**
   * Reads jobs WITHOUT consuming them — Redis keeps finished jobs (subject to
   * retention), so inspection here is non-destructive, which is why BullMQ can
   * offer `list` at all.
   *
   * One `getJobs` per state, each capped at `limit`: that keeps every job's
   * state known without an extra `job.getState()` round-trip per job, and
   * stops one busy state (usually `completed`) from starving the others. The
   * merged result is sorted newest-first and truncated to `limit`.
   */
  async list(queue: string, options: ListJobsOptions = {}): Promise<JobSummary[]> {
    const requested = options.states?.length ? options.states : DEFAULT_LIST_STATES
    const states = [...new Set(requested)]
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT)

    const summaries: JobSummary[] = []
    for (const state of states) {
      const jobs = await this.queue(queue).getJobs([state], 0, limit - 1)
      for (const job of jobs) {
        // getJobs can yield holes when a job is removed mid-read (retention).
        if (job) summaries.push(toSummary(job, state))
      }
    }
    summaries.sort((a, b) => b.timestamp - a.timestamp)
    return summaries.slice(0, limit)
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()))
    await Promise.all([...this.queues.values()].map((queue) => queue.close()))
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name)
    if (!queue) {
      queue = new Queue(name, { connection: this.connection })
      queue.on('error', (error) => this.onError(error, { queue: name, source: 'queue' }))
      this.queues.set(name, queue)
    }
    return queue
  }
}

/**
 * BullMQ `Job` → driver-neutral {@link JobSummary}. The BullMQ object never
 * escapes the driver, and `job.data` (the dispatch envelope) is opened so the
 * caller sees its own payload.
 */
function toSummary(job: Job, state: JobState): JobSummary {
  const { payload, context } = readJobEnvelope(job.data)
  return {
    id: String(job.id ?? ''),
    name: job.name,
    state,
    attemptsMade: job.attemptsMade ?? 0,
    timestamp: job.timestamp ?? 0,
    payload,
    ...(context !== undefined ? { context } : {}),
    ...(job.failedReason ? { failedReason: job.failedReason } : {}),
  }
}

function parseRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname && parsed.pathname !== '/' ? { db: Number(parsed.pathname.slice(1)) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    // required by BullMQ for workers
    maxRetriesPerRequest: null,
  }
}

/**
 * Everything {@link queuePlugin} accepts, minus `driver` (this plugin IS the
 * driver choice), plus the BullMQ connection and its crash-safety hooks.
 */
export interface BullmqQueuePluginOptions
  extends Omit<QueuePluginOptions, 'driver'>,
    BullmqDriverOptions {}

/**
 * The BullMQ-backed queue plugin — jobs on Redis in one line:
 *
 * ```ts
 * bullmqQueuePlugin({
 *   connection: process.env.REDIS_URL!,
 *   jobs: [SendWelcome],
 *   workers: [{ queue: 'welcome', concurrency: 5 }],
 * })
 * ```
 *
 * Each backend ships its own plugin of this shape (`rabbitmqQueuePlugin`,
 * `sqsQueuePlugin`, `kafkaQueuePlugin`), so no backend is privileged in the
 * core's API and `@basaltkit/queue` stays a pure contract. Use
 * `queuePlugin({ driver })` directly for a driver you wrote yourself.
 *
 * The driver is built here, when the app is DEFINED, which is safe because the
 * constructor performs no I/O: it parses the connection string and stores the
 * handlers, while the underlying `Queue`/`Worker` objects — and therefore every
 * Redis socket — are created lazily on first use. The one visible consequence
 * is welcome: a malformed connection string throws at definition time instead
 * of at the first dispatch.
 */
export function bullmqQueuePlugin(options: BullmqQueuePluginOptions) {
  // Split by the CORE's keys, not the driver's: a new driver option then flows
  // through untouched, and only a change to QueuePluginOptions needs an edit here.
  const { jobs, workers, onUnsupported, removeOnComplete, removeOnFail, ...driver } = options
  return queuePlugin({
    ...(jobs !== undefined ? { jobs } : {}),
    ...(workers !== undefined ? { workers } : {}),
    ...(onUnsupported !== undefined ? { onUnsupported } : {}),
    ...(removeOnComplete !== undefined ? { removeOnComplete } : {}),
    ...(removeOnFail !== undefined ? { removeOnFail } : {}),
    driver: new BullmqQueueDriver(driver),
  })
}
