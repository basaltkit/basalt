import { createHmac, timingSafeEqual } from 'node:crypto'
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

/**
 * Two DIFFERENT job definitions were registered under the same name. The
 * worker looks a job up by name, so the second one used to replace the first
 * silently — its handler then ran for both producers.
 */
export class DuplicateJobError extends BasaltError {
  readonly status = 500
  constructor(job: string) {
    super(
      'QUEUE_DUPLICATE_JOB',
      `A different job named "${job}" is already registered in this QueueManager. ` +
        'Job names are the routing key between producer and worker, so they must be unique — ' +
        'rename one of them (for two queuedOn listeners on the same event, pass `name`).',
    )
  }
}

/**
 * The envelope's signature is missing or does not verify under any configured
 * `signingKey`. The handler does NOT run: the message was not written by a
 * producer holding the key (or was altered on the broker).
 */
export class JobSignatureError extends BasaltError {
  readonly status = 500
  constructor(job: string, reason: 'missing' | 'invalid') {
    super(
      'QUEUE_BAD_SIGNATURE',
      `Job "${job}" was rejected: its envelope signature is ${reason}. ` +
        'Only producers holding the queue `signingKey` can enqueue jobs this worker runs.',
    )
  }
}

/**
 * The envelope's context carries an identity field (`tenant`, `tenantId`,
 * `userId`) of the wrong shape. The job fails closed instead of running with
 * the field dropped — a job that loses its tenant would run in the central
 * scope, which is a widening, not a safe default.
 */
export class JobContextError extends BasaltError {
  readonly status = 500
  constructor(job: string, field: string) {
    super(
      'QUEUE_INVALID_CONTEXT',
      `Job "${job}" was rejected: its context field "${field}" is malformed.`,
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

/** Informational fields: restored when well-formed, silently dropped otherwise. */
const TRACE_FIELDS = ['requestId', 'correlationId', 'traceId'] as const

/** Longest string restored from an envelope's context (ids, not documents). */
const MAX_CONTEXT_STRING = 256

/**
 * The default tenant-id grammar the worker accepts from an envelope — the same
 * as `@basaltkit/tenancy`'s default (`TENANT_ID_PATTERN` minus the reserved
 * `global`), duplicated here so the queue does not depend on tenancy. An app
 * that configured a custom grammar there passes the same function as
 * `validateTenantId`.
 */
const DEFAULT_TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const isDefaultTenantId = (id: string): boolean =>
  DEFAULT_TENANT_ID_PATTERN.test(id) && id !== 'global'

/** A key for {@link QueueManagerOptions.signingKey}. */
export type QueueSigningKey = string | Uint8Array

/** Minimum signing-key length, in bytes — an HMAC-SHA256 key shorter than this is guessable. */
export const MIN_SIGNING_KEY_BYTES = 32

const SIGNATURE_PREFIX = 'v1:'

export interface QueueManagerOptions {
  /** Reaction when a job uses an option the driver can't honor. Default 'warn'. */
  onUnsupported?: UnsupportedPolicy
  /** Sink for 'warn' diagnostics. Default console.warn. */
  warn?: (message: string) => void
  /** Default retention for completed jobs (a job can override). Driver default: keep 1000. */
  removeOnComplete?: JobRetention
  /** Default retention for failed jobs (a job can override). Driver default: keep all. */
  removeOnFail?: JobRetention
  /**
   * HMAC-SHA256 key(s) that sign every dispatch envelope (job name + payload +
   * context). With a key set, the worker REJECTS a job whose signature is
   * missing or wrong ({@link JobSignatureError}) — so writing to the broker is
   * no longer enough to run a job or to choose its tenant/user.
   *
   * Pass an array to rotate: the FIRST key signs, every key verifies. Each key
   * must be at least {@link MIN_SIGNING_KEY_BYTES} bytes. Producers and workers
   * must share it. Without a key the broker is trusted (see the queues guide).
   */
  signingKey?: QueueSigningKey | readonly QueueSigningKey[]
  /**
   * Tenant-id grammar the worker accepts from an envelope's context. Default:
   * `@basaltkit/tenancy`'s default grammar. A job whose tenant id fails it is
   * rejected ({@link JobContextError}), never run without its tenant.
   */
  validateTenantId?: (id: string) => boolean
}

export class QueueManager implements JobDispatcher {
  private readonly jobs = new Map<string, JobDefinition<never>>()
  private readonly onUnsupported: UnsupportedPolicy
  private readonly warn: (message: string) => void
  private readonly warned = new Set<string>()
  private readonly defaultRemoveOnComplete: JobRetention | undefined
  private readonly defaultRemoveOnFail: JobRetention | undefined
  private readonly signingKeys: Buffer[]
  private readonly validateTenantId: (id: string) => boolean

  constructor(
    private readonly driver: QueueDriver,
    options: QueueManagerOptions = {},
  ) {
    this.onUnsupported = options.onUnsupported ?? 'warn'
    this.warn = options.warn ?? ((message) => console.warn(message))
    this.defaultRemoveOnComplete = options.removeOnComplete
    this.defaultRemoveOnFail = options.removeOnFail
    this.signingKeys = normalizeSigningKeys(options.signingKey)
    this.validateTenantId = options.validateTenantId ?? isDefaultTenantId
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

  /**
   * Registers a job. Registering the SAME definition twice is a no-op;
   * registering a DIFFERENT definition under a taken name throws
   * {@link DuplicateJobError} (it used to replace the first silently).
   */
  register(job: JobDefinition<never> | JobDefinition<unknown>): this {
    const existing = this.jobs.get(job.name)
    if (existing !== undefined && existing !== job) throw new DuplicateJobError(job.name)
    this.jobs.set(job.name, job as JobDefinition<never>)
    job.__bind(this)
    return this
  }

  async dispatch<T>(job: JobDefinition<T>, payload: T, options: DispatchOptions = {}): Promise<void> {
    if (this.jobs.get(job.name) !== job) this.register(job as JobDefinition<unknown>)

    const validated = validatePayload(job, payload)
    const context = snapshotContext()
    const envelope: JobEnvelope = {
      payload: validated,
      context,
      ...(this.signingKeys.length > 0
        ? { sig: sign(this.signingKeys[0] as Buffer, job.name, validated, context) }
        : {}),
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

  /**
   * Executes a job received from the driver: verifies the signature (when a
   * key is configured), validates the payload, restores a minimal, validated
   * context, runs the handler.
   */
  private async execute(jobName: string, data: unknown): Promise<void> {
    const job = this.jobs.get(jobName)
    if (!job) throw new UnknownJobError(jobName)

    const envelope = (typeof data === 'object' && data !== null ? data : {}) as JobEnvelope
    if (this.signingKeys.length > 0) this.verify(jobName, envelope)
    const payload = validatePayload(job, envelope.payload)
    const context = restoreContext(jobName, envelope.context, this.validateTenantId)
    await runWithContext(context, () => job.handle(payload as never))
  }

  private verify(jobName: string, envelope: JobEnvelope): void {
    const sig = envelope.sig
    if (typeof sig !== 'string' || !sig.startsWith(SIGNATURE_PREFIX)) {
      throw new JobSignatureError(jobName, 'missing')
    }
    const given = Buffer.from(sig)
    for (const key of this.signingKeys) {
      const expected = Buffer.from(sign(key, jobName, envelope.payload, envelope.context))
      if (given.length === expected.length && timingSafeEqual(given, expected)) return
    }
    throw new JobSignatureError(jobName, 'invalid')
  }
}

function normalizeSigningKeys(option: QueueManagerOptions['signingKey']): Buffer[] {
  if (option === undefined) return []
  const list = (Array.isArray(option) ? option : [option]) as QueueSigningKey[]
  return list.map((key) => {
    const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key)
    if (bytes.length < MIN_SIGNING_KEY_BYTES) {
      throw new BasaltError(
        'QUEUE_WEAK_SIGNING_KEY',
        `The queue signingKey must be at least ${MIN_SIGNING_KEY_BYTES} bytes (got ${bytes.length}).`,
      )
    }
    return bytes
  })
}

/**
 * HMAC over the job NAME, payload and context — binding the name stops a
 * signed payload for one job being replayed under another job's name. JSON is
 * the canonical form because every driver already moves the envelope as JSON,
 * and `JSON.stringify` is stable across a parse/stringify round trip.
 */
function sign(key: Buffer, jobName: string, payload: unknown, context: unknown): string {
  const canonical = JSON.stringify(['basalt-job-v1', jobName, payload ?? null, context ?? null])
  return SIGNATURE_PREFIX + createHmac('sha256', key).update(canonical).digest('base64url')
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function isSafeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CONTEXT_STRING &&
    !CONTROL_CHARS.test(value)
  )
}

/**
 * Rebuilds the worker's context from an envelope — an allowlist, never a
 * spread. Whatever else the broker message carries is ignored.
 *
 * - `requestId` / `correlationId` / `traceId`: kept when they are short,
 *   printable strings; dropped otherwise (they only label logs).
 * - `tenant` / `tenantId`: must satisfy `validateTenantId` and agree with each
 *   other, or the job is rejected — dropping them would run the job in the
 *   central scope.
 * - `userId`: must be a short, printable string, or the job is rejected. It is
 *   restored as `userId` AND as a minimal actor `user: { id }`, so audit
 *   (`actorId`) and permissions (`gate.actor()`) see who dispatched the job.
 *   The actor carries only the id: roles are re-read from the permission
 *   store in the job's tenant, never trusted from the message.
 */
function restoreContext(
  jobName: string,
  raw: unknown,
  validateTenantId: (id: string) => boolean,
): RequestContext {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new JobContextError(jobName, 'context')
  const source = raw as Record<string, unknown>
  const context: Record<string, unknown> = {}

  for (const field of TRACE_FIELDS) {
    if (isSafeString(source[field])) context[field] = source[field]
  }

  const tenantIdOf = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !validateTenantId(value)) throw new JobContextError(jobName, field)
    return value
  }
  let tenantId: string | undefined
  if (source['tenant'] !== undefined) {
    const tenant = source['tenant']
    if (typeof tenant !== 'object' || tenant === null) throw new JobContextError(jobName, 'tenant')
    tenantId = tenantIdOf((tenant as { id?: unknown }).id, 'tenant.id')
  }
  if (source['tenantId'] !== undefined) {
    const id = tenantIdOf(source['tenantId'], 'tenantId')
    if (tenantId !== undefined && id !== tenantId) throw new JobContextError(jobName, 'tenantId')
    context['tenantId'] = id
  }
  if (tenantId !== undefined) context['tenant'] = { id: tenantId }

  if (source['userId'] !== undefined) {
    const userId = source['userId']
    if (!isSafeString(userId)) throw new JobContextError(jobName, 'userId')
    context['userId'] = userId
    context['user'] = { id: userId }
  }
  return context as RequestContext
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
