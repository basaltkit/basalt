import type { EventBus, MachizeEvent } from '@machize/events'
import { defineJob, type JobBackoff } from './job.js'
import type { QueueManager } from './manager.js'

export interface QueuedListenerOptions {
  queue?: string
  attempts?: number
  backoff?: JobBackoff
}

/**
 * A ponte events→queue: o listener vira um job — o emit só enfileira,
 * e o handler roda no worker com retry/backoff do driver e o contexto
 * (tenant/requestId) restaurado.
 *
 * queuedOn(bus, queue, OrderCreated, async ({ orderId }) => { ... })
 *
 * Retorna a função de unsubscribe do listener.
 */
export function queuedOn<T>(
  bus: EventBus,
  manager: QueueManager,
  event: MachizeEvent<T>,
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
