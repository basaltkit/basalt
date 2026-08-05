import {
  MachizeError,
  parseDuration,
  runWithContext,
  tryCtx,
  type RequestContext,
} from '@machize/core'
import type { AddJobOptions, QueueDriver } from './driver.js'
import {
  validatePayload,
  type DispatchOptions,
  type JobDefinition,
  type JobDispatcher,
} from './job.js'

export class UnknownJobError extends MachizeError {
  constructor(job: string) {
    super(
      'QUEUE_UNKNOWN_JOB',
      `Job "${job}" chegou ao worker mas não está registrado neste processo. ` +
        'Garanta que o worker registra os mesmos jobs do produtor.',
    )
  }
}

/** Campos do contexto serializados junto com o payload e restaurados no worker. */
const SNAPSHOT_FIELDS = ['requestId', 'correlationId', 'traceId', 'userId', 'tenantId'] as const

interface JobEnvelope {
  payload: unknown
  context?: RequestContext | undefined
}

export class QueueManager implements JobDispatcher {
  private readonly jobs = new Map<string, JobDefinition<never>>()

  constructor(private readonly driver: QueueDriver) {
    driver.setExecutor((jobName, data) => this.execute(jobName, data))
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
    }
    await this.driver.add(job.queue, job.name, envelope, addOptions)
  }

  /** Inicia um worker para a fila. No driver sync é no-op. */
  work(queue = 'default', options: { concurrency?: number } = {}): void {
    this.driver.startWorker(queue, options)
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  /** Executa um job recebido do driver: valida, restaura o contexto e roda o handler. */
  private async execute(jobName: string, data: unknown): Promise<void> {
    const job = this.jobs.get(jobName)
    if (!job) throw new UnknownJobError(jobName)

    const envelope = data as JobEnvelope
    const payload = validatePayload(job, envelope.payload)
    await runWithContext({ ...(envelope.context ?? {}) }, () => job.handle(payload as never))
  }
}

/** Extrai do contexto atual apenas o que é serializável e útil no worker. */
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
