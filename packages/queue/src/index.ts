import { BasaltError, createToken, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_STATES,
  type JobState,
  type QueueDriver,
} from './driver.js'
// TYPE-ONLY on purpose — see `loadBullmqDriver` below. Turning this into a
// value import (or re-exporting the class from this barrel) would pull `bullmq`
// into every consumer of `@basaltkit/queue` again; `tests/lazy-bullmq.test.ts`
// and the driver-agnostic boundary test both fail if it ever happens.
import type { BullmqDriverOptions } from './drivers/bullmq.js'
import { SyncQueueDriver } from './drivers/sync.js'
import type { JobDefinition, JobRetention } from './job.js'
import { QueueManager, type UnsupportedPolicy } from './manager.js'

export {
  defineJob,
  JobValidationError,
  JobNotRegisteredError,
  type JobDefinition,
  type JobSchema,
  type JobBackoff,
  type JobRetention,
  type DispatchOptions,
} from './job.js'
export {
  QueueManager,
  UnknownJobError,
  UnsupportedJobOptionError,
  type UnsupportedPolicy,
  type QueueManagerOptions,
} from './manager.js'
export { queuedOn, type QueuedListenerOptions } from './bridge.js'
export { SyncQueueDriver } from './drivers/sync.js'
/**
 * The BullMQ driver's *types* stay on the barrel (erased at build, so they cost
 * a consumer nothing). The CLASS lives at its own entry point:
 * `import { BullmqQueueDriver } from '@basaltkit/queue/bullmq'` — the same
 * shape as the RabbitMQ/SQS/Kafka driver packages, one import path per backend.
 */
export type { BullmqDriverOptions } from './drivers/bullmq.js'
export {
  readJobEnvelope,
  DEFAULT_LIST_STATES,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type QueueDriver,
  type QueueStats,
  type AddJobOptions,
  type JobExecutor,
  type DriverCapabilities,
  type JobState,
  type JobSummary,
  type JobEnvelope,
  type ListJobsOptions,
} from './driver.js'

export const QUEUE = createToken<QueueManager>('queue')

/**
 * `bullmq` is an OPTIONAL peer dependency of this package, not a dependency:
 * `@basaltkit/queue` is the driver-agnostic core, and an app on SQS, RabbitMQ,
 * Kafka or the sync driver must neither install nor load BullMQ (and its
 * ioredis weight) to use it. Only the `queuePlugin({ connection })` shorthand
 * needs it, so only that path resolves the module — once, cached here.
 */
type BullmqDriverModule = typeof import('./drivers/bullmq.js')

let bullmqDriverModule: BullmqDriverModule | undefined

/** Actionable guidance instead of a bare ERR_MODULE_NOT_FOUND from deep inside the driver. */
const MISSING_BULLMQ =
  '`queuePlugin({ connection })` selects the BullMQ driver, which needs the `bullmq` package — ' +
  'an optional peer dependency of @basaltkit/queue that is not installed. ' +
  'Either install it (`pnpm add bullmq`), or pass an explicit `driver:` — ' +
  '`@basaltkit/queue-rabbitmq`, `@basaltkit/queue-sqs`, `@basaltkit/queue-kafka`, ' +
  'or `new SyncQueueDriver()` for dev/tests.'

export class MissingQueueDriverPackageError extends BasaltError {
  constructor(options?: ErrorOptions) {
    super('QUEUE_MISSING_DRIVER_PACKAGE', MISSING_BULLMQ, options)
  }
}

async function loadBullmqDriver(): Promise<BullmqDriverModule> {
  if (bullmqDriverModule) return bullmqDriverModule
  try {
    bullmqDriverModule = await import('./drivers/bullmq.js')
  } catch (error) {
    throw new MissingQueueDriverPackageError({ cause: error })
  }
  return bullmqDriverModule
}

export interface QueuePluginOptions {
  /** Jobs known to this process (producer and/or worker). */
  jobs?: JobDefinition<unknown>[]
  /** Redis connection → BullMQ driver. No connection → sync driver (dev/test). */
  connection?: BullmqDriverOptions['connection']
  /** Custom driver — overrides `connection`. */
  driver?: QueueDriver
  /** Queues to start workers for in this process at boot. */
  workers?: { queue: string; concurrency?: number }[]
  /**
   * What to do when a job uses an option the driver can't honor (e.g. a
   * delayed job on a driver without delayed delivery). Default 'warn' — set
   * 'throw' in production for a hard guarantee, 'ignore' for the old behavior.
   */
  onUnsupported?: UnsupportedPolicy
  /**
   * Default retention for completed jobs in Redis (BullMQ). `true` removes on
   * finish, a number keeps that many, `{ age: '7d', count: 500 }` caps both.
   * Default: keep the last 1000. A job can override via `defineJob`.
   */
  removeOnComplete?: JobRetention
  /**
   * Default retention for failed jobs. Default `false` (keep all, for inspection
   * and retries) — set e.g. `{ age: '14d' }` so failures don't grow unbounded.
   */
  removeOnFail?: JobRetention
  /**
   * Infra errors from the driver's broker client (e.g. Redis down). Forwarded
   * to the driver built from `connection`; default `console.error` with context.
   * Ignored when you pass your own `driver` — configure it on the driver then.
   */
  onError?: BullmqDriverOptions['onError']
  /**
   * A job exhausted its retries. Forwarded to the driver built from
   * `connection`; default `console.error` with context. Ignored when you pass
   * your own `driver` — configure it on the driver then.
   */
  onJobFailed?: BullmqDriverOptions['onJobFailed']
}

export function queuePlugin(options: QueuePluginOptions = {}) {
  return definePlugin({
    name: 'basalt:queue',
    async register({ container }) {
      // Resolve the BullMQ driver MODULE here — `BasaltApp.boot()` awaits
      // `register`, so the class is in hand before anything can resolve QUEUE,
      // and the container factory below stays synchronous. This is still a
      // bindings-only phase: loading a module is not I/O against the world —
      // no Redis connection is opened until the singleton is first resolved.
      // Doing it in `boot` instead would leave a hole: a plugin booting earlier
      // that resolves QUEUE would hit an unloaded driver.
      if (!options.driver && options.connection) await loadBullmqDriver()

      registerQueueCommands(container)
      container.singleton(QUEUE, () => {
        let driver = options.driver
        if (!driver) {
          if (options.connection) {
            // Defensive: only reachable if `register`'s promise was dropped by
            // a non-standard host instead of awaited.
            if (!bullmqDriverModule) throw new MissingQueueDriverPackageError()
            driver = new bullmqDriverModule.BullmqQueueDriver({
              connection: options.connection,
              ...(options.onError !== undefined ? { onError: options.onError } : {}),
              ...(options.onJobFailed !== undefined ? { onJobFailed: options.onJobFailed } : {}),
            })
          } else {
            driver = new SyncQueueDriver()
            if (process.env['NODE_ENV'] === 'production') {
              // The silent default without a Redis connection is the inline sync
              // driver: at-most-once, no background retries, handler errors
              // propagate into the dispatching request. Deliberate sync use in
              // production stays possible — pass `driver: new SyncQueueDriver()`
              // explicitly to silence this.
              console.warn(
                '[basalt:queue] No `connection` (Redis) configured — falling back to the inline sync driver. ' +
                  'Jobs run at-most-once inside the dispatching request and are lost on failure. ' +
                  'Configure a Redis `connection` for production, or pass `driver: new SyncQueueDriver()` to opt in explicitly.',
              )
            }
          }
        }
        const manager = new QueueManager(driver, {
          ...(options.onUnsupported !== undefined ? { onUnsupported: options.onUnsupported } : {}),
          ...(options.removeOnComplete !== undefined ? { removeOnComplete: options.removeOnComplete } : {}),
          ...(options.removeOnFail !== undefined ? { removeOnFail: options.removeOnFail } : {}),
        })
        for (const job of options.jobs ?? []) manager.register(job)
        return manager
      })
    },
    boot({ container }) {
      const manager = container.get(QUEUE)
      for (const worker of options.workers ?? []) {
        manager.work(worker.queue,
          worker.concurrency !== undefined ? { concurrency: worker.concurrency } : {})
      }
    },
    async shutdown({ container }) {
      await container.get(QUEUE).close()
    },
  })
}

/** The states `queue:jobs --states` accepts — the driver-neutral vocabulary. */
const LIST_STATES: readonly JobState[] = ['waiting', 'active', 'completed', 'failed', 'delayed']

/** Parses `--states failed,waiting`. Throws on an unknown state rather than silently dropping it. */
function parseStates(raw: string | boolean | undefined): JobState[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const states = raw.split(',').map((part) => part.trim()).filter(Boolean)
  const unknown = states.filter((state) => !LIST_STATES.includes(state as JobState))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown job state(s): ${unknown.join(', ')}. Valid states: ${LIST_STATES.join(', ')}.`,
    )
  }
  return states as JobState[]
}

/** Compact age for the CLI table ('3s', '12m', '4h', '2d') — friendlier than an epoch. */
function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/** One-line, length-capped rendering of an arbitrary value for a table cell. */
function preview(value: unknown, max = 120): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = (text ?? String(value)).replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Registers `queue:work`, `queue:stats`, `queue:retry` and `queue:jobs` into the
 * CLI command bucket. Commands resolve the manager lazily, so they work with whatever driver
 * the app configured. Registered structurally to avoid a hard @basaltkit/cli dep.
 */
function registerQueueCommands(container: Container): void {
  const manager = () => container.get(QUEUE)
  const unsupported =
    'Not supported by the active queue driver — the inline sync driver keeps no job state. Use the BullMQ driver (a Redis `connection`).'
  const unsupportedList =
    'Not supported by the active queue driver — listing jobs needs a backend that can read a job WITHOUT consuming it. ' +
    'Use the BullMQ driver (a Redis `connection`); the sync driver keeps no job state, and the RabbitMQ/SQS/Kafka drivers cannot list non-destructively.'

  ensureMetadata(container).add('commands', {
    name: 'queue:work',
    description: 'Run a worker that processes jobs for a queue (Ctrl+C to stop)',
    async handle({ io, flags }: { io: { log(m: string): void }; flags: Record<string, string | boolean> }) {
      const queue = typeof flags['queue'] === 'string' ? flags['queue'] : 'default'
      const concurrency = typeof flags['concurrency'] === 'string' ? Number(flags['concurrency']) : undefined
      manager().work(queue, concurrency !== undefined ? { concurrency } : {})
      io.log(`Worker started on queue "${queue}"${concurrency ? ` (concurrency ${concurrency})` : ''}. Ctrl+C to stop.`)
      await new Promise<void>((resolve) => process.once('SIGINT', resolve))
    },
  })

  ensureMetadata(container).add('commands', {
    name: 'queue:stats',
    description: 'Show job counts (waiting/active/completed/failed/delayed) for a queue',
    async handle({
      io,
      flags,
    }: {
      io: { log(m: string): void; table(rows: Record<string, unknown>[]): void }
      flags: Record<string, string | boolean>
    }) {
      const queue = typeof flags['queue'] === 'string' ? flags['queue'] : 'default'
      const stats = await manager().stats(queue)
      if (!stats) {
        io.log(unsupported)
        return
      }
      io.table([{ queue, ...stats }])
    },
  })

  ensureMetadata(container).add('commands', {
    name: 'queue:retry',
    description: 'Re-enqueue failed jobs on a queue',
    async handle({
      io,
      flags,
    }: {
      io: { log(m: string): void }
      flags: Record<string, string | boolean>
    }) {
      const queue = typeof flags['queue'] === 'string' ? flags['queue'] : 'default'
      const limit = typeof flags['limit'] === 'string' ? Number(flags['limit']) : undefined
      const retried = await manager().retryFailed(queue, limit !== undefined ? { limit } : {})
      if (retried === undefined) {
        io.log(unsupported)
        return
      }
      io.log(`Re-enqueued ${retried} failed job(s) on "${queue}".`)
    },
  })

  ensureMetadata(container).add('commands', {
    name: 'queue:jobs',
    description:
      'List individual jobs on a queue (id/name/state/attempts); --payload also prints their data',
    async handle({
      io,
      flags,
    }: {
      io: { log(m: string): void; table(rows: Record<string, unknown>[]): void }
      flags: Record<string, string | boolean>
    }) {
      const queue = typeof flags['queue'] === 'string' ? flags['queue'] : 'default'
      const states = parseStates(flags['states'])
      const limit = typeof flags['limit'] === 'string' ? Number(flags['limit']) : undefined
      const jobs = await manager().list(queue, {
        ...(states !== undefined ? { states } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
      if (!jobs) {
        io.log(unsupportedList)
        return
      }
      const asked = (states ?? DEFAULT_LIST_STATES).join(', ')
      if (jobs.length === 0) {
        io.log(`No jobs on "${queue}" in ${asked}.`)
        return
      }
      // Payloads can hold personal data, so they are NOT printed by default —
      // `--payload` is the deliberate opt-in (same posture as the docs' warning).
      const withPayload = flags['payload'] === true || flags['payload'] === 'true'
      const now = Date.now()
      const anyFailed = jobs.some((job) => job.failedReason !== undefined)
      io.table(
        jobs.map((job) => ({
          id: job.id,
          name: job.name,
          state: job.state,
          attempts: job.attemptsMade,
          age: formatAge(job.timestamp, now),
          ...(anyFailed ? { reason: job.failedReason ? preview(job.failedReason, 60) : '' } : {}),
          ...(withPayload ? { payload: preview(job.payload) } : {}),
        })),
      )
      io.log(
        `${jobs.length} job(s) on "${queue}" (${asked}, limit ${limit ?? DEFAULT_LIST_LIMIT}).` +
          (withPayload
            ? ' Payloads shown — they can contain personal data.'
            : ' Payloads hidden — add --payload to include them.'),
      )
    },
  })
}
