import { definePlugin, runWithContext, tryCtx } from '@basaltkit/core'
import {
  EVENTS,
  Outbox,
  MemoryOutboxStore,
  OUTBOX,
  type OutboxDispatch,
  type OutboxEntry,
  type OutboxStore,
} from '@basaltkit/events'
import { WEBHOOKS, type DeliveryResult, type WebhookManager } from './index.js'

/**
 * Durable, at-least-once **integration events over the app's own webhooks.**
 *
 * `webhooksPlugin({ events })` dispatches domain events straight to subscribers
 * fire-and-forget — a failed delivery or a crash between "committed" and
 * "delivered" loses the event. This bridge instead records each event in a
 * transactional {@link Outbox} first, then a relay publishes it to webhook
 * subscribers with retries. Every re-delivery of an entry to an endpoint
 * carries the same signed `id` (derived from the entry id and the endpoint id),
 * so subscribers dedupe on it; endpoints that already accepted an entry are
 * skipped on its retries while the process lives (at-least-once across
 * restarts — hence the stable id).
 */

/** Options for {@link webhookOutboxDispatch}. */
export interface WebhookOutboxDispatchOptions {
  /**
   * Called when an entry finished with only PERMANENT failures left (SSRF-blocked
   * URL, redirect, non-retryable `4xx`, refused signing secret): the entry is
   * NOT retried for them. Default: console.warn. Must never throw.
   */
  onPermanentFailure?: (entry: OutboxEntry, failures: DeliveryResult[]) => void
  /**
   * Entries whose per-endpoint progress is remembered between retries (default
   * 10_000). Oldest are forgotten first; a forgotten entry just re-delivers to
   * every endpoint with the same stable ids.
   */
  maxTrackedEntries?: number
}

/**
 * An {@link OutboxDispatch} that publishes an entry to the current webhook
 * subscribers. Throws only if a delivery failed TRANSIENTLY (network, timeout,
 * `5xx`, `408`/`429`), so the outbox retries; a retry skips endpoints that
 * already accepted the entry and re-sends the same delivery `id` to the rest.
 * Permanent failures are reported via `onPermanentFailure` and never re-queue
 * the entry (re-dispatching them would only duplicate deliveries to healthy
 * endpoints). An entry recorded without a tenant reaches only tenant-agnostic
 * endpoints.
 *
 * Each entry is dispatched in a fresh, tenant-less context scoped by the
 * entry's OWN tenant: a relay flushed from inside a tenant's request must not
 * let that request's ambient tenant (which `dispatch` gives precedence to)
 * re-route other tenants' entries to the caller's endpoints. From there the
 * manager enters the entry's tenant for the endpoint lookup only, through its
 * `runInTenant` (wired by `webhooksPlugin` to tenancyPlugin's `'tenancy:run'`
 * signal), so a per-tenant webhook store (`tenantClient()`) resolves that
 * tenant's database; deliveries run after the lookup settles. A runner failure
 * — e.g. the entry's tenant was deleted — rejects the dispatch, so the entry
 * goes through the outbox's normal retry and dead-letter path.
 */
export function webhookOutboxDispatch(webhooks: WebhookManager, options: WebhookOutboxDispatchOptions = {}): OutboxDispatch {
  const maxTracked = options.maxTrackedEntries ?? 10_000
  const onPermanentFailure =
    options.onPermanentFailure ??
    ((entry: OutboxEntry, failures: DeliveryResult[]) =>
      console.warn(
        `[basalt:webhook-outbox] "${entry.event}" (${entry.id}) permanently failed for endpoint(s) ` +
          failures.map((f) => `${f.endpointId} (${f.error ?? `HTTP ${f.status}`})`).join(', ') +
          '; not retrying them',
      ))
  // entry id → endpoint ids that already accepted it (insertion-ordered for eviction).
  const delivered = new Map<string, Set<string>>()

  return async (entry: OutboxEntry) => {
    const done = delivered.get(entry.id) ?? new Set<string>()
    const results = await runWithContext({}, () =>
      webhooks.dispatch(entry.event, entry.payload, {
        ...(entry.tenantId != null ? { tenantId: entry.tenantId } : {}),
        idempotencyKey: entry.id,
        skipEndpointIds: done,
      }),
    )
    for (const r of results) if (r.ok) done.add(r.endpointId)
    const failed = results.filter((r) => !r.ok)
    // A missing flag (custom deliverer/manager) is treated as retryable: the
    // pre-existing, conservative behaviour.
    const transient = failed.filter((r) => r.retryable !== false)
    const permanent = failed.filter((r) => r.retryable === false)
    if (permanent.length > 0) {
      try {
        onPermanentFailure(entry, permanent)
      } catch {
        // a reporting hook must never change the delivery outcome
      }
    }
    if (transient.length > 0) {
      delivered.delete(entry.id) // re-insert at the end (most recent)
      delivered.set(entry.id, done)
      while (delivered.size > maxTracked) delivered.delete(delivered.keys().next().value!)
      throw new Error(`${transient.length}/${results.length} webhook deliveries failed transiently for "${entry.event}"`)
    }
    delivered.delete(entry.id)
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
  /**
   * Entries of one flush delivered in parallel (default 8), so one tenant's slow
   * or failing endpoint cannot hold every other tenant's deliveries behind it.
   */
  concurrency?: number
  /**
   * Most deliveries one tenant may have in flight at once, across flushes
   * (default `ceil(concurrency / 2)`). See `OutboxOptions.tenantConcurrency`.
   */
  tenantConcurrency?: number
  /**
   * How long a flush waits on one entry's delivery before moving on (default
   * 10_000 ms; `false` = wait indefinitely). The delivery keeps running detached
   * and its outcome is still recorded — see `OutboxOptions.dispatchTimeoutMs`.
   * With the default deliverer a hanging endpoint takes up to ~4 × `timeoutMs`
   * plus backoff to fail, so this is what keeps the relay ticking meanwhile.
   */
  dispatchTimeoutMs?: number | false
  /**
   * A timer/shutdown flush failed at the store level (e.g. `pending()` threw).
   * Default: console.error. Must never throw.
   */
  onFlushError?: (error: unknown) => void
  /** See {@link WebhookOutboxDispatchOptions.onPermanentFailure}. Default: console.warn. */
  onPermanentFailure?: WebhookOutboxDispatchOptions['onPermanentFailure']
  /**
   * Capture only events emitted inside a tenant context (default false). Set it
   * when endpoints live per tenant (a store over `tenantClient()`): a tenant-less
   * entry has no tenant-agnostic endpoints to reach there and would only
   * dead-letter.
   */
  tenantOnly?: boolean
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
  const outbox = new Outbox(store, {
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.tenantConcurrency !== undefined ? { tenantConcurrency: options.tenantConcurrency } : {}),
    ...(options.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: options.dispatchTimeoutMs } : {}),
  })
  const onFlushError =
    options.onFlushError ?? ((error: unknown) => console.error('[basalt:webhook-outbox] flush failed:', error))
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
      dispatch = webhookOutboxDispatch(
        webhooks,
        options.onPermanentFailure ? { onPermanentFailure: options.onPermanentFailure } : {},
      )

      for (const pattern of patterns) {
        bus.on(pattern, (payload, meta) => {
          const tenantId = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
          if (options.tenantOnly && tenantId === undefined) return
          void outbox.enqueue(meta.name, payload, tenantId)
        })
      }

      if (intervalMs > 0) {
        // The catch keeps a store fault from becoming an unhandled rejection.
        timer = setInterval(() => void outbox.flush(dispatch!, options.batchSize).catch(onFlushError), intervalMs)
        timer.unref()
      }
    },
    async shutdown() {
      if (timer) clearInterval(timer)
      if (!dispatch) return
      try {
        await outbox.flush(dispatch, options.batchSize) // best-effort final drain
      } catch (error) {
        onFlushError(error)
      }
    },
  })
}
