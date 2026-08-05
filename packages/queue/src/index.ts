import { createToken, definePlugin } from '@machize/core'
import { BullmqQueueDriver, type BullmqDriverOptions } from './drivers/bullmq.js'
import { SyncQueueDriver } from './drivers/sync.js'
import type { QueueDriver } from './driver.js'
import type { JobDefinition } from './job.js'
import { QueueManager } from './manager.js'

export {
  defineJob,
  JobValidationError,
  JobNotRegisteredError,
  type JobDefinition,
  type JobSchema,
  type JobBackoff,
  type DispatchOptions,
} from './job.js'
export { QueueManager, UnknownJobError } from './manager.js'
export { queuedOn, type QueuedListenerOptions } from './bridge.js'
export { SyncQueueDriver } from './drivers/sync.js'
export { BullmqQueueDriver, type BullmqDriverOptions } from './drivers/bullmq.js'
export type { QueueDriver, AddJobOptions, JobExecutor } from './driver.js'

export const QUEUE = createToken<QueueManager>('queue')

export interface QueuePluginOptions {
  /** Jobs conhecidos por este processo (produtor e/ou worker). */
  jobs?: JobDefinition<never>[]
  /** Conexão Redis → driver BullMQ. Sem conexão → driver sync (dev/teste). */
  connection?: BullmqDriverOptions['connection']
  /** Driver customizado — sobrepõe `connection`. */
  driver?: QueueDriver
  /** Filas para iniciar workers neste processo no boot. */
  workers?: { queue: string; concurrency?: number }[]
}

export function queuePlugin(options: QueuePluginOptions = {}) {
  return definePlugin({
    name: 'machize:queue',
    register({ container }) {
      container.singleton(QUEUE, () => {
        const driver =
          options.driver ??
          (options.connection
            ? new BullmqQueueDriver({ connection: options.connection })
            : new SyncQueueDriver())
        const manager = new QueueManager(driver)
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
