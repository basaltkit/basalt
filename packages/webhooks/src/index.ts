import { createToken, definePlugin, tryCtx } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { WebhookDeliverer, type DeliveryResult, type WebhookDelivererOptions } from './deliver.js'
import { MemoryWebhookStore, type WebhookEndpoint, type WebhookStore } from './store.js'

export {
  MemoryWebhookStore,
  matchesEvent,
  type WebhookStore,
  type WebhookEndpoint,
} from './store.js'
export {
  WebhookDeliverer,
  signPayload,
  verifySignature,
  type DeliveryResult,
  type WebhookDelivererOptions,
} from './deliver.js'

/** Register/list subscriptions and dispatch events to matching endpoints. */
export class WebhookManager {
  constructor(
    private readonly store: WebhookStore,
    private readonly deliverer: WebhookDeliverer,
  ) {}

  register(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> {
    return this.store.add(endpoint)
  }
  unregister(id: string): Promise<void> {
    return this.store.remove(id)
  }
  list(tenantId?: string): Promise<WebhookEndpoint[]> {
    return this.store.list(tenantId)
  }

  /** Delivers to every endpoint subscribed to `event` (optionally tenant-scoped). */
  async dispatch(event: string, data: unknown, tenantId?: string): Promise<DeliveryResult[]> {
    const endpoints = await this.store.forEvent(event, tenantId)
    return Promise.all(endpoints.map((endpoint) => this.deliverer.deliver(endpoint, event, data)))
  }
}

export const WEBHOOKS = createToken<WebhookManager>('webhooks')

export interface WebhooksPluginOptions extends WebhookDelivererOptions {
  store?: WebhookStore
  deliverer?: WebhookDeliverer
  /** Domain event patterns to auto-dispatch (requires @basaltkit/events). */
  events?: string[]
}

/**
 * Wires outbound webhooks. Resolve `WEBHOOKS` to manage subscriptions and
 * dispatch manually, or pass `events` to auto-dispatch domain events —
 * tenant-scoped from the request context, fire-and-forget so the emitter
 * never blocks on HTTP.
 */
export function webhooksPlugin(options: WebhooksPluginOptions = {}) {
  const store = options.store ?? new MemoryWebhookStore()
  const deliverer = options.deliverer ?? new WebhookDeliverer(options)
  const manager = new WebhookManager(store, deliverer)
  const autoEvents = options.events ?? []

  return definePlugin({
    name: 'basalt:webhooks',
    dependsOn: autoEvents.length ? ['basalt:events'] : [],
    register({ container }) {
      container.singleton(WEBHOOKS, () => manager)
    },
    boot({ container }) {
      if (autoEvents.length === 0) return
      const bus = container.get(EVENTS)
      for (const pattern of autoEvents) {
        bus.on(pattern, (payload, meta) => {
          const tenantId = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
          void manager.dispatch(meta.name, payload, tenantId)
        })
      }
    },
  })
}
