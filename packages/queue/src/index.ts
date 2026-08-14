import { createToken, definePlugin } from '@basaltkit/core'
import { BullmqQueueDriver, type BullmqDriverOptions } from './drivers/bullmq.js'
import { SyncQueueDriver } from './drivers/sync.js'
import type { QueueDriver } from './driver.js'
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
export { BullmqQueueDriver, type BullmqDriverOptions } from './drivers/bullmq.js'
export type { QueueDriver, AddJobOptions, JobExecutor, DriverCapabilities } from './driver.js'

export const QUEUE = createToken<QueueManager>('queue')

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
}

export function queuePlugin(options: QueuePluginOptions = {}) {
  return definePlugin({
    name: 'basalt:queue',
    register({ container }) {
      container.singleton(QUEUE, () => {
        const driver =
          options.driver ??
          (options.connection
            ? new BullmqQueueDriver({ connection: options.connection })
            : new SyncQueueDriver())
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
