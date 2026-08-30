import {
  BasaltError,
  parseDuration,
  runWithContext,
  tryCtx,
  type RequestContext,
} from '@basaltkit/core'
import type {
  AddJobOptions,
  DriverCapabilities,
  JobEnvelope,
  JobSummary,
  ListJobsOptions,
  QueueDriver,
  QueueStats,
  RetentionOption,
} from './driver.js'
import {
  validatePayload,
  type DispatchOptions,
  type JobDefinition,
  type JobDispatcher,
  type JobRetention,
} from './job.js'

/** Convert a public {@link JobRetention} to the driver-neutral shape (age → ms). */
function resolveRetention(retention: JobRetention | undefined): RetentionOption | undefined {
  if (retention === undefined) return undefined
  if (typeof retention === 'boolean' || typeof retention === 'number') return retention
  const out: { ageMs?: number; count?: number } = {}
  if (retention.age !== undefined) out.ageMs = parseDuration(retention.age)
  if (retention.count !== undefined) out.count = retention.count
  return out
}

export class UnknownJobError extends BasaltError {
  constructor(job: string) {
    super(
      'QUEUE_UNKNOWN_JOB',
      `Job "${job}" reached the worker but is not registered in this process. ` +
        'Make sure the worker registers the same jobs as the producer.',
    )
  }
}

/** A job used an option the active driver doesn't support (with policy 'throw'). */
export class UnsupportedJobOptionError extends BasaltError {
  readonly status = 500
  constructor(driver: string, job: string, features: string[]) {
    super(
      'QUEUE_UNSUPPORTED_OPTION',
      `The "${driver}" queue driver does not support ${features.join(', ')} ` +
        `(job "${job}"). Use a driver that supports it, remove the option, or ` +
        `set queuePlugin({ onUnsupported: 'warn' | 'ignore' }).`,
    )
  }
}

/**
 * What to do when a dispatch uses an option the driver can't honor:
 * - `throw`: raise {@link UnsupportedJobOptionError} (strict; recommended in prod)
 * - `warn`: log once per job+feature and proceed (default — never silent)
 * - `ignore`: proceed silently (legacy behavior)
 */
export type UnsupportedPolicy = 'throw' | 'warn' | 'ignore'

/** Maps a dispatch's options to the capability each one requires. */
const requiredCapabilities = (options: AddJobOptions): (keyof DriverCapabilities)[] => {
  const needed: (keyof DriverCapabilities)[] = []
  if (options.delayMs !== undefined && options.delayMs > 0) needed.push('delayed')
  if (options.priority !== undefined) needed.push('priority')
  if (options.attempts > 1) needed.push('retries')
  if (options.backoff && options.attempts > 1) needed.push('backoff')
  return needed
}

const FEATURE_LABELS: Record<keyof DriverCapabilities, string> = {
  delayed: 'delayed jobs (delay)',
  priority: 'priority',
  retries: 'retries (attempts > 1)',
  backoff: 'retry backoff',
}

/** Context fields serialized along with the payload and restored in the worker. */
const SNAPSHOT_FIELDS = ['requestId', 'correlationId', 'traceId', 'userId', 'tenantId'] as const

export interface QueueManagerOptions {
  /** Reaction when a job uses an option the driver can't honor. Default 'warn'. */
  onUnsupported?: UnsupportedPolicy
  /** Sink for 'warn' diagnostics. Default console.warn. */
  warn?: (message: string) => void
  /** Default retention for completed jobs (a job can override). Driver default: keep 1000. */
  removeOnComplete?: JobRetention
  /** Default retention for failed jobs (a job can override). Driver default: keep all. */
  removeOnFail?: JobRetention
}

export class QueueManager implements JobDispatcher {
  private readonly jobs = new Map<string, JobDefinition<never>>()
  private readonly onUnsupported: UnsupportedPolicy
  private readonly warn: (message: string) => void
  private readonly warned = new Set<string>()
  private readonly defaultRemoveOnComplete: JobRetention | undefined
  private readonly defaultRemoveOnFail: JobRetention | undefined

  constructor(
    private readonly driver: QueueDriver,
    options: QueueManagerOptions = {},
  ) {
    this.onUnsupported = options.onUnsupported ?? 'warn'
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.defaultRemoveOnComplete = options.removeOnComplete
    this.defaultRemoveOnFail = options.removeOnFail
    driver.setExecutor((jobName, data) => this.execute(jobName, data))
  }

  /**
   * Checks the dispatch's options against the driver's declared capabilities.
   * A driver that omits `capabilities` is assumed fully capable (back-compat).
   */
  private assertSupported(jobName: string, options: AddJobOptions): void {
    const caps = this.driver.capabilities
    if (!caps || this.onUnsupported === 'ignore') return

    const missing = requiredCapabilities(options).filter((cap) => !caps[cap])
    if (missing.length === 0) return

    const driverName = this.driver.name ?? 'queue'
    const features = missing.map((cap) => FEATURE_LABELS[cap])
    if (this.onUnsupported === 'throw') throw new UnsupportedJobOptionError(driverName, jobName, features)

    const key = `${jobName}:${missing.join(',')}`
    if (this.warned.has(key)) return // warn once per job+feature combination
    this.warned.add(key)
    this.warn(
      `[basalt/queue] The "${driverName}" driver does not support ${features.join(', ')} — ` +
        `job "${jobName}" will run without it.`,
    )
  }

  register(job: JobDefinition<never> | JobDefinition<unknown>): this {
    this.jobs.set(job.name, job as JobDefinition<never>)
    job.__bind(this)
    return this
  }

  async dispatch<T>(job: JobDefinition<T>, payload: T, options: DispatchOptions = {}): Promise<void> {
    if (!this.jobs.has(job.name)) this.register(job as JobDefinition<unknown>)

    const envelope: JobEnvelope = {
      payload: validatePayload(job, payload),
      context: snapshotContext(),
    }
    const addOptions: AddJobOptions = {
      attempts: job.attempts,
      backoff: job.backoff
        ? { type: job.backoff.type, delayMs: parseDuration(job.backoff.delay) }
        : undefined,
      delayMs: options.delay === undefined ? undefined : parseDuration(options.delay),
      priority: options.priority,
      // Per-job overrides the queuePlugin default; undefined leaves the driver default.
      removeOnComplete: resolveRetention(job.removeOnComplete ?? this.defaultRemoveOnComplete),
      removeOnFail: resolveRetention(job.removeOnFail ?? this.defaultRemoveOnFail),
    }
    this.assertSupported(job.name, addOptions)
    await this.driver.add(job.queue, job.name, envelope, addOptions)
  }

  /** Starts a worker for the queue. With the sync driver it is a no-op. */
  work(queue = 'default', options: { concurrency?: number } = {}): void {
    this.driver.startWorker(queue, options)
  }

  /** Job counts per state, or `undefined` if the driver can't introspect. */
  async stats(queue = 'default'): Promise<QueueStats | undefined> {
    return this.driver.stats?.(queue)
  }

  /**
   * Re-enqueues failed jobs; returns the count, or `undefined` if the driver
   * doesn't support retrying (e.g. the inline sync driver).
   */
  async retryFailed(queue = 'default', options: { limit?: number } = {}): Promise<number | undefined> {
    return this.driver.retryFailed?.(queue, options)
  }

  /**
   * Lists individual jobs on the queue — newest first, with each job's own
   * payload already unwrapped from the dispatch envelope. Returns `undefined`
   * when the driver can't list (the sync driver keeps no state; a broker that
   * cannot read a message without consuming it deliberately omits `list`).
   *
   * This is the supported alternative to reaching around the framework into
   * the broker's own client, which couples the app to one backend.
   *
   * A summary carries the job's payload, so it can carry personal data —
   * treat the result as sensitive (see the queues guide).
   */
  async list(queue = 'default', options: ListJobsOptions = {}): Promise<JobSummary[] | undefined> {
    return this.driver.list?.(queue, options)
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  /** Executes a job received from the driver: validates, restores the context, runs the handler. */
  private async execute(jobName: string, data: unknown): Promise<void> {
    const job = this.jobs.get(jobName)
    if (!job) throw new UnknownJobError(jobName)

    const envelope = data as JobEnvelope
    const payload = validatePayload(job, envelope.payload)
    await runWithContext({ ...(envelope.context ?? {}) }, () => job.handle(payload as never))
  }
}

/** Extracts from the current context only what is serializable and useful in the worker. */
function snapshotContext(): RequestContext | undefined {
  const context = tryCtx()
  if (!context) return undefined

  const snapshot: Record<string, unknown> = {}
  for (const field of SNAPSHOT_FIELDS) {
    if (context[field] !== undefined) snapshot[field] = context[field]
  }
  const tenant = context['tenant'] as { id?: string } | undefined
  if (tenant?.id) snapshot['tenant'] = { id: tenant.id }
  const user = context['user'] as { id?: string } | undefined
  if (user?.id && snapshot['userId'] === undefined) snapshot['userId'] = user.id

  return Object.keys(snapshot).length > 0 ? (snapshot as RequestContext) : undefined
}
