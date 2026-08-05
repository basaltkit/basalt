import { MachizeError, type DurationInput } from '@machize/core'

/** Schema estrutural compatível com Zod. */
export interface JobSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class JobValidationError extends MachizeError {
  constructor(
    readonly job: string,
    readonly issues: unknown,
  ) {
    super('JOB_INVALID', `Payload inválido para o job "${job}": ${JSON.stringify(issues)}`)
  }
}

export class JobNotRegisteredError extends MachizeError {
  constructor(job: string) {
    super(
      'QUEUE_JOB_NOT_REGISTERED',
      `Job "${job}" ainda não foi registrado num QueueManager. ` +
        'Adicione-o em queuePlugin({ jobs: [...] }) ou chame manager.register(job).',
    )
  }
}

export interface DispatchOptions {
  delay?: DurationInput
  priority?: number
}

export interface JobBackoff {
  type: 'exponential' | 'fixed'
  delay: DurationInput
}

export interface JobDefinition<T = unknown> {
  readonly name: string
  readonly schema?: JobSchema<T> | undefined
  readonly queue: string
  readonly attempts: number
  readonly backoff?: JobBackoff | undefined
  handle(payload: T): void | Promise<void>
  /** Enfileira o job — disponível após o registro num QueueManager. */
  dispatch(payload: T, options?: DispatchOptions): Promise<void>
  /** @internal usado pelo QueueManager ao registrar */
  __bind(dispatcher: JobDispatcher): void
}

export interface JobDispatcher {
  dispatch<T>(job: JobDefinition<T>, payload: T, options?: DispatchOptions): Promise<void>
}

/**
 * Define um job declarativo:
 *
 * export const SendWelcomeEmail = defineJob({
 *   name: 'email.welcome',
 *   schema: z.object({ userId: z.string() }),
 *   attempts: 3,
 *   backoff: { type: 'exponential', delay: '30s' },
 *   async handle({ userId }) { ... },
 * })
 */
export function defineJob<T = unknown>(config: {
  name: string
  schema?: JobSchema<T>
  queue?: string
  attempts?: number
  backoff?: JobBackoff
  handle(payload: T): void | Promise<void>
}): JobDefinition<T> {
  let dispatcher: JobDispatcher | undefined

  const job: JobDefinition<T> = {
    name: config.name,
    schema: config.schema,
    queue: config.queue ?? 'default',
    attempts: config.attempts ?? 1,
    backoff: config.backoff,
    handle: config.handle,
    async dispatch(payload, options) {
      if (!dispatcher) throw new JobNotRegisteredError(config.name)
      return dispatcher.dispatch(job, payload, options)
    },
    __bind(d) {
      dispatcher = d
    },
  }
  return job
}

export function validatePayload<T>(job: JobDefinition<T>, payload: unknown): T {
  if (!job.schema) return payload as T
  const result = job.schema.safeParse(payload)
  if (!result.success) {
    const issues =
      (result.error as { issues?: unknown[] } | undefined)?.issues ?? result.error ?? 'desconhecido'
    throw new JobValidationError(job.name, issues)
  }
  return result.data as T
}
