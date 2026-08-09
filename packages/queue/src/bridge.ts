import type { EventBus, BasaltEvent } from '@basaltkit/events'
import { defineJob, type JobBackoff } from './job.js'
import type { QueueManager } from './manager.js'

export interface QueuedListenerOptions {
  queue?: string
  attempts?: number
  backoff?: JobBackoff
}

/**
 * The events→queue bridge: the listener becomes a job — emit only enqueues,
 * and the handler runs in the worker with the driver's retry/backoff and the
 * context (tenant/requestId) restored.
 *
 * queuedOn(bus, queue, OrderCreated, async ({ orderId }) => { ... })
 *
 * Returns the listener's unsubscribe function.
 */
export function queuedOn<T>(
  bus: EventBus,
  manager: QueueManager,
  event: BasaltEvent<T>,
  handler: (payload: T) => void | Promise<void>,
  options: QueuedListenerOptions = {},
): () => void {
  const job = defineJob<T>({
    name: `listener:${event.name}`,
    ...(event.schema ? { schema: event.schema } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    handle: handler,
  })
  manager.register(job as never)

  return bus.on(event, async (payload) => {
    await job.dispatch(payload)
  })
}
