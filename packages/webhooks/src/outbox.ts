import { definePlugin, tryCtx } from '@basaltkit/core'
import {
  EVENTS,
  Outbox,
  MemoryOutboxStore,
  OUTBOX,
  type OutboxDispatch,
  type OutboxEntry,
  type OutboxStore,
} from '@basaltkit/events'
import { WEBHOOKS, type WebhookManager } from './index.js'

/**
 * Durable, at-least-once **integration events over the app's own webhooks.**
 *
 * `webhooksPlugin({ events })` dispatches domain events straight to subscribers
 * fire-and-forget — a failed delivery or a crash between "committed" and
 * "delivered" loses the event. This bridge instead records each event in a
 * transactional {@link Outbox} first, then a relay publishes it to webhook
 * subscribers with retries. Subscribers must be idempotent (standard webhook
 * practice) since a partial failure re-delivers the whole entry.
 */

/**
 * An {@link OutboxDispatch} that publishes an entry to the current webhook
 * subscribers. Throws if any endpoint delivery fails, so the outbox retries.
 */
export function webhookOutboxDispatch(webhooks: WebhookManager): OutboxDispatch {
  return async (entry: OutboxEntry) => {
    const results = await webhooks.dispatch(entry.event, entry.payload, entry.tenantId)
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      throw new Error(`${failed.length}/${results.length} webhook deliveries failed for "${entry.event}"`)
    }
  }
}

export interface WebhookOutboxOptions {
  /** Durable outbox store. Default in-memory — swap for a DB-backed store in production. */
  store?: OutboxStore
  /** Event patterns to capture into the outbox. Default `['**']` (all events). */
  events?: string[]
  /** Relay poll interval (ms). Default 5000. Set `0` to relay only manually via the `OUTBOX` token. */
  intervalMs?: number
  /** Entries delivered per flush. Default 50. */
  batchSize?: number
  /** Attempts before an entry is left dead-lettered. Default 10. */
  maxAttempts?: number
}

/**
 * Wires the durable webhook outbox: captures the configured domain events into a
 * transactional outbox and relays them to webhook subscribers with retry.
 * Requires `webhooksPlugin` and `eventsPlugin`. Resolve the `OUTBOX` token to
 * enqueue or flush manually (e.g. from a queue worker instead of the timer).
 */
export function webhookOutboxPlugin(options: WebhookOutboxOptions = {}) {
  const store = options.store ?? new MemoryOutboxStore()
  const patterns = options.events ?? ['**']
  const intervalMs = options.intervalMs ?? 5000
  const outbox = new Outbox(store, options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {})
  let dispatch: OutboxDispatch | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  return definePlugin({
    name: 'basalt:webhook-outbox',
    dependsOn: ['basalt:webhooks', 'basalt:events'],
    register({ container }) {
      container.singleton(OUTBOX, () => outbox)
    },
    boot({ container }) {
      const webhooks = container.get(WEBHOOKS)
      const bus = container.get(EVENTS)
      dispatch = webhookOutboxDispatch(webhooks)

      for (const pattern of patterns) {
        bus.on(pattern, (payload, meta) => {
          const tenantId = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
          void outbox.enqueue(meta.name, payload, tenantId)
        })
      }

      if (intervalMs > 0) {
        timer = setInterval(() => void outbox.flush(dispatch!, options.batchSize), intervalMs)
        timer.unref()
      }
    },
    async shutdown() {
      if (timer) clearInterval(timer)
      if (dispatch) await outbox.flush(dispatch, options.batchSize) // best-effort final drain
    },
  })
}
