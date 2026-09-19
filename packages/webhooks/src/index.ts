import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { generateWebhookSecret, WebhookDeliverer, type DeliveryResult, type WebhookDelivererOptions } from './deliver.js'
import { matchesEvent, MemoryWebhookStore, type WebhookEndpoint, type WebhookStore } from './store.js'

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
  generateWebhookSecret,
  MIN_WEBHOOK_SECRET_LENGTH,
  PINNED_ADDRESS,
  type DeliveryResult,
  type WebhookDelivererOptions,
} from './deliver.js'
export {
  assertDeliverableUrl,
  resolveAndValidate,
  pinnedLookup,
  isPrivateIp,
  WebhookUrlBlockedError,
  type SsrfGuardOptions,
  type ValidatedAddress,
  type ValidatedTarget,
} from './ssrf.js'

const currentTenantId = (): string | undefined => asTenantId((tryCtx() as { tenant?: { id?: unknown } } | undefined)?.tenant?.id)

/**
 * Normalises a caller-supplied tenant id: only a non-empty string is a tenant.
 * Anything else (`null` from a JSON body, `''`, numbers, arrays, objects) is
 * "no tenant", so it hits the same fail-closed rules as a missing one instead of
 * slipping past `=== undefined` checks — a `null` tenant column is read back by
 * the SQL stores as a GLOBAL endpoint that receives every tenant's events.
 */
const asTenantId = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * Thrown when a webhook management call runs without a tenant (no ambient
 * tenant, no explicit `tenantId`) in a multi-tenant app and without the explicit
 * `{ system: true }` opt-in — it would otherwise create a global endpoint that
 * receives every tenant's events, or read/delete every tenant's endpoints.
 */
export class WebhookTenantRequiredError extends Error {
  readonly code = 'WEBHOOKS_TENANT_REQUIRED'
  constructor(operation: string) {
    super(
      `webhooks.${operation}() needs a tenant: tenancy is active but there is no tenant in context and no explicit tenantId. ` +
        'Pass a tenantId, or { system: true } for a deliberate system-wide operation.',
    )
    this.name = 'WebhookTenantRequiredError'
  }
}

/** An endpoint as returned by {@link WebhookManager.list}: the signing secret is never included. */
export type WebhookEndpointView = Omit<WebhookEndpoint, 'secret'> & { hasSecret: boolean }

const redact = ({ secret, ...rest }: WebhookEndpoint): WebhookEndpointView => ({ ...rest, hasSecret: secret !== undefined })

export interface WebhookManagerOptions {
  /**
   * True when the app is multi-tenant. `webhooksPlugin` wires this to the
   * `'tenancy:active'` marker set by `tenancyPlugin`. When true, `register`,
   * `list` and `unregister` refuse to run unscoped (no tenant) unless called
   * with `{ system: true }`.
   */
  tenancyActive?: () => boolean
}

/** Explicit scope for {@link WebhookManager.dispatch} off the request path. */
export interface WebhookDispatchOptions {
  /** Deliver as this tenant (ignored when a tenant is in context — anti-widening). */
  tenantId?: string
  /**
   * Deliberate system fan-out: deliver to every matching endpoint of EVERY
   * tenant. Ignored inside a tenant context. Without it, a tenant-less dispatch
   * reaches only tenant-agnostic endpoints.
   */
  allTenants?: boolean
}

/** Register/list subscriptions and dispatch events to matching endpoints. */
export class WebhookManager {
  private readonly tenancyActive: () => boolean

  constructor(
    private readonly store: WebhookStore,
    private readonly deliverer: WebhookDeliverer,
    options: WebhookManagerOptions = {},
  ) {
    this.tenancyActive = options.tenancyActive ?? (() => false)
  }

  private requireScope(operation: string, tenantId: string | undefined, system: boolean | undefined): void {
    if (tenantId === undefined && !system && this.tenancyActive()) throw new WebhookTenantRequiredError(operation)
  }

  /** Refuses a caller-supplied endpoint id that already exists outside `tenantId`'s scope. */
  private async assertOwnId(id: string, tenantId: string | undefined): Promise<void> {
    if (tenantId !== undefined && (await this.store.list(tenantId)).some((e) => e.id === id && e.tenantId === tenantId)) return
    const existing = (await this.store.list()).find((e) => e.id === id)
    if (existing && (existing.tenantId ?? undefined) !== tenantId) {
      throw new Error(`webhooks.register(): endpoint id "${id}" is already in use by another scope.`)
    }
  }

  /**
   * Registers an endpoint and returns it — including its signing `secret`, which
   * is generated (`whsec_…`) when none is given for a tenant-bound endpoint (or
   * when the deliverer has no default secret). Store it / show it to the
   * customer now: {@link list} never returns secrets.
   *
   * Bound to the ambient tenant when one is in context (a caller-supplied
   * `tenantId` can't override it). With tenancy active and no tenant at all,
   * pass an explicit `tenantId`, or `{ system: true }` to deliberately create a
   * global endpoint that receives every tenant's events.
   */
  async register(
    endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string },
    options: { system?: boolean } = {},
  ): Promise<WebhookEndpoint> {
    const tenantId = currentTenantId() ?? asTenantId(endpoint.tenantId)
    this.requireScope('register', tenantId, options.system)
    const { tenantId: _ignored, ...rest } = endpoint
    // A caller-supplied id upserts in every store: never let it replace an
    // endpoint that belongs to a different tenant (or a global one, when scoped).
    if (endpoint.id !== undefined) await this.assertOwnId(endpoint.id, tenantId)
    const needsOwnSecret = tenantId !== undefined || !(this.deliverer as { hasDefaultSecret?: boolean }).hasDefaultSecret
    const secret = endpoint.secret ?? (needsOwnSecret ? generateWebhookSecret() : undefined)
    return this.store.add({
      ...rest,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(secret !== undefined ? { secret } : {}),
    })
  }

  /**
   * Removes an endpoint, scoped to the ambient tenant (or `options.tenantId`):
   * a no-op for an endpoint another tenant owns. With tenancy active and no
   * tenant, `{ system: true }` is required.
   */
  async unregister(id: string, options: { tenantId?: string; system?: boolean } = {}): Promise<void> {
    const tenantId = currentTenantId() ?? asTenantId(options.tenantId)
    this.requireScope('unregister', tenantId, options.system)
    return this.store.remove(id, tenantId)
  }

  /**
   * Lists endpoints (secrets redacted). Anti-widening: a tenant in the ambient
   * context always wins — a caller-supplied `tenantId` (which may carry client
   * input) can never widen or switch the scope. With no context tenant, an
   * explicit `tenantId` is honoured; no scope at all lists every endpoint, which
   * with tenancy active requires `{ system: true }`.
   */
  async list(tenantId?: string, options: { system?: boolean } = {}): Promise<WebhookEndpointView[]> {
    const scope = currentTenantId() ?? asTenantId(tenantId)
    this.requireScope('list', scope, options.system)
    const endpoints = await this.store.list(scope)
    return (scope === undefined ? endpoints : endpoints.filter((e) => e.tenantId === scope)).map(redact)
  }

  /**
   * Delivers to every endpoint subscribed to `event`, fail-closed on tenancy:
   * - inside a tenant context the delivery is FORCED to that tenant's endpoints
   *   plus tenant-agnostic ones (anti-widening);
   * - off the request path an explicit `tenantId` does the same for that tenant;
   * - with no tenant at all only tenant-agnostic endpoints are reached — never a
   *   tenant-bound one — unless `{ allTenants: true }` asks for system fan-out.
   * The result is re-filtered here, so a store that ignores the tenant argument
   * can't widen delivery.
   */
  async dispatch(event: string, data: unknown, scope?: string | WebhookDispatchOptions): Promise<DeliveryResult[]> {
    const options: WebhookDispatchOptions = typeof scope === 'string' ? { tenantId: scope } : (scope ?? {})
    const ambient = currentTenantId()
    const tenantId = ambient ?? asTenantId(options.tenantId)
    let endpoints: WebhookEndpoint[]
    if (tenantId !== undefined) {
      endpoints = (await this.store.forEvent(event, tenantId)).filter(
        (e) => e.tenantId == null || e.tenantId === tenantId,
      )
    } else if (options.allTenants) {
      // Deliberate system fan-out: read every endpoint explicitly — `forEvent`
      // without a tenant is fail-closed (tenant-agnostic endpoints only).
      endpoints = (await this.store.list()).filter((e) => (e.active ?? true) && matchesEvent(e.events, event))
    } else {
      endpoints = (await this.store.forEvent(event)).filter((e) => e.tenantId == null)
    }
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
 * never blocks on HTTP. An event emitted with no tenant in context reaches only
 * tenant-agnostic endpoints.
 */
export function webhooksPlugin(options: WebhooksPluginOptions = {}) {
  const store = options.store ?? new MemoryWebhookStore()
  const deliverer = options.deliverer ?? new WebhookDeliverer(options)
  const autoEvents = options.events ?? []

  return definePlugin({
    name: 'basalt:webhooks',
    dependsOn: autoEvents.length ? ['basalt:events'] : [],
    register({ container }) {
      // 'tenancy:active' is tenancyPlugin's marker — a signal, not an import.
      // Resolved per call, so plugin registration order does not matter.
      const metadata = ensureMetadata(container)
      const manager = new WebhookManager(store, deliverer, {
        tenancyActive: () => metadata.get('tenancy:active').length > 0,
      })
      container.singleton(WEBHOOKS, () => manager)
    },
    boot({ container }) {
      if (autoEvents.length === 0) return
      const bus = container.get(EVENTS)
      const manager = container.get(WEBHOOKS)
      for (const pattern of autoEvents) {
        bus.on(pattern, (payload, meta) => {
          const tenantId = currentTenantId()
          void manager.dispatch(meta.name, payload, tenantId).catch((error: unknown) =>
            console.error(`[basalt:webhooks] auto-dispatch of "${meta.name}" failed:`, error),
          )
        })
      }
    },
  })
}

export {
  webhookOutboxDispatch,
  webhookOutboxPlugin,
  type WebhookOutboxOptions,
} from './outbox.js'
