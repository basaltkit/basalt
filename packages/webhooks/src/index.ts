import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { deriveDeliveryId, generateWebhookSecret, MIN_WEBHOOK_SECRET_LENGTH, WebhookDeliverer, type DeliveryResult, type WebhookDelivererOptions } from './deliver.js'
import { effectivePort, isPortAllowed } from './ssrf.js'
import { matchesEvent, MemoryWebhookStore, WebhookEndpointIdInUseError, type WebhookEndpoint, type WebhookStore } from './store.js'

export {
  MemoryWebhookStore,
  WebhookEndpointIdInUseError,
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
  pinnedFetch,
  deriveDeliveryId,
  type DeliveryResult,
  type DeliverOptions,
  type WebhookDelivererOptions,
} from './deliver.js'
export {
  assertDeliverableUrl,
  DEFAULT_BLOCKED_PORTS,
  effectivePort,
  isPortAllowed,
  resolveAndValidate,
  pinnedLookup,
  isPrivateIp,
  WebhookUrlBlockedError,
  type SsrfGuardOptions,
  type ValidatedAddress,
  type ValidatedTarget,
} from './ssrf.js'
export {
  createGuardedFetch,
  capStream,
  hostAllowed,
  pinnedStreamTransport,
  GuardedFetchError,
  type GuardedFetch,
  type GuardedFetchErrorKind,
  type GuardedFetchOptions,
  type GuardedRequestInit,
  type GuardedResponse,
  type GuardedTransport,
} from './guarded-fetch.js'

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

/**
 * Thrown by {@link WebhookManager.register} for an endpoint that could never be
 * delivered to: a URL that is not an absolute URL with an allowed scheme and
 * port, a signing secret shorter than `MIN_WEBHOOK_SECRET_LENGTH`, or an empty
 * event list. Registration fails instead of storing an endpoint whose every
 * delivery would be refused later. (Whether the host is public is still decided
 * at delivery time, where DNS is resolved and the connection pinned.) Also
 * thrown by {@link WebhookManager.rotateSecret} for an invalid rotation.
 */
export class WebhookEndpointInvalidError extends Error {
  readonly code = 'WEBHOOK_ENDPOINT_INVALID'
  readonly status = 400
  constructor(reason: string, operation = 'register') {
    super(`webhooks.${operation}(): ${reason}.`)
    this.name = 'WebhookEndpointInvalidError'
  }
}

/** Thrown by {@link WebhookManager.rotateSecret} when the endpoint does not exist in the caller's scope. */
export class WebhookEndpointNotFoundError extends Error {
  readonly code = 'WEBHOOK_ENDPOINT_NOT_FOUND'
  readonly status = 404
  constructor(id: string) {
    super(`@basaltkit/webhooks: endpoint "${id}" was not found.`)
    this.name = 'WebhookEndpointNotFoundError'
  }
}

const DEFAULT_SCHEMES: readonly string[] = ['https:', 'http:']

/** Default rotation grace window: 24 hours. */
export const DEFAULT_SECRET_ROTATION_GRACE_SECONDS = 86_400
/** Longest rotation grace window `rotateSecret()` accepts: 30 days. */
export const MAX_SECRET_ROTATION_GRACE_SECONDS = 30 * 86_400
/** Default most endpoints one tenant may have subscribed to one event before a dispatch refuses it. */
export const DEFAULT_MAX_ENDPOINTS_PER_DISPATCH = 100
/** Default most deliveries one `dispatch()` runs at once. */
export const DEFAULT_DISPATCH_CONCURRENCY = 16

function assertRegistrable(
  endpoint: Omit<WebhookEndpoint, 'id'>,
  schemes: readonly string[],
  allowsPort: (port: number) => boolean,
): void {
  const { url, secret, events } = endpoint as { url: unknown; secret?: unknown; events: unknown }
  if (typeof url !== 'string' || url.length === 0) throw new WebhookEndpointInvalidError('url must be a non-empty string')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new WebhookEndpointInvalidError('url is not a valid absolute URL')
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new WebhookEndpointInvalidError(`url scheme "${parsed.protocol}" is not allowed (allowed: ${schemes.join(', ')})`)
  }
  const port = effectivePort(parsed)
  if (port !== undefined && !allowsPort(port)) {
    throw new WebhookEndpointInvalidError(`url port ${port} is not allowed (see the ssrf.allowedPorts option)`)
  }
  if (secret != null && (typeof secret !== 'string' || secret.length < MIN_WEBHOOK_SECRET_LENGTH)) {
    throw new WebhookEndpointInvalidError(
      `secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters (omit it to have one generated)`,
    )
  }
  const { previousSecret, previousSecretExpiresAt } = endpoint as { previousSecret?: unknown; previousSecretExpiresAt?: unknown }
  if (previousSecret != null) {
    if (typeof previousSecret !== 'string' || previousSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
      throw new WebhookEndpointInvalidError(`previousSecret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`)
    }
    if (!(previousSecretExpiresAt instanceof Date) || Number.isNaN(previousSecretExpiresAt.getTime())) {
      throw new WebhookEndpointInvalidError('previousSecret needs a valid previousSecretExpiresAt date (the grace window must be bounded)')
    }
  }
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string' && e.length > 0)) {
    throw new WebhookEndpointInvalidError('events must be a non-empty array of non-empty event patterns')
  }
}

/**
 * An endpoint as returned by {@link WebhookManager.list}: signing secrets (the
 * current one and a rotation's previous one) are never included.
 */
export type WebhookEndpointView = Omit<WebhookEndpoint, 'secret' | 'previousSecret'> & { hasSecret: boolean }

const redact = ({ secret, previousSecret: _previous, ...rest }: WebhookEndpoint): WebhookEndpointView => ({
  ...rest,
  hasSecret: secret != null,
})

/** Reported through `onFanOutExceeded` when a dispatch refuses one scope's endpoints. */
export interface WebhookFanOutExceeded {
  event: string
  /** The tenant whose endpoints were refused; `undefined` for tenant-agnostic endpoints. */
  tenantId: string | undefined
  /** How many active endpoints of that scope matched the event. */
  endpoints: number
  /** The configured `maxEndpointsPerDispatch`. */
  limit: number
}

/** Fan-out bounds for {@link WebhookManager.dispatch}. `webhooksPlugin` forwards them. */
export interface WebhookFanOutOptions {
  /**
   * Most active endpoints ONE scope (a tenant, or the tenant-agnostic set) may
   * have subscribed to one event. A dispatch that matches more refuses that
   * scope entirely — none of its endpoints is sent to, each gets a failed
   * result (`retryable: false`) — rather than silently picking some of them;
   * other scopes of the same dispatch are unaffected. `false` disables the cap.
   * Default {@link DEFAULT_MAX_ENDPOINTS_PER_DISPATCH} (100).
   */
  maxEndpointsPerDispatch?: number | false
  /** Most deliveries one dispatch runs at once. Default {@link DEFAULT_DISPATCH_CONCURRENCY} (16). */
  dispatchConcurrency?: number
  /**
   * Called once per refused scope (alerting/metrics). Default: `console.warn`.
   * Must not throw — an exception is logged and swallowed.
   */
  onFanOutExceeded?: (info: WebhookFanOutExceeded) => void
}

function assertPositiveInteger(name: string, value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`webhooks: \`${name}\` must be a positive integer (got ${String(value)}).`)
  }
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface WebhookManagerOptions extends WebhookFanOutOptions {
  /**
   * True when the app is multi-tenant. `webhooksPlugin` wires this to the
   * `'tenancy:active'` marker set by `tenancyPlugin`. When true, `register`,
   * `list` and `unregister` refuse to run unscoped (no tenant) unless called
   * with `{ system: true }`.
   */
  tenancyActive?: () => boolean
  /** Clock in epoch ms, for the rotation grace window (tests). Default `Date.now`. */
  now?: () => number
}

/** Options for {@link WebhookManager.rotateSecret}. */
export interface WebhookRotateSecretOptions {
  /** Scope off the request path (ignored when a tenant is in context — anti-widening). */
  tenantId?: string
  /** Deliberate unscoped rotation with tenancy active and no tenant. */
  system?: boolean
  /** The new secret (min 16 chars). Default: a freshly generated `whsec_…`. */
  secret?: string
  /**
   * How long deliveries keep being signed with the previous secret too, in
   * seconds. `0` cuts over immediately (the previous secret stops signing now).
   * Default {@link DEFAULT_SECRET_ROTATION_GRACE_SECONDS} (24 h); at most
   * {@link MAX_SECRET_ROTATION_GRACE_SECONDS} (30 days).
   */
  graceSeconds?: number
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
  /**
   * Idempotency key of this logical dispatch (e.g. an outbox entry id). When
   * set, each endpoint's delivery id is derived from it and the endpoint id
   * ({@link deriveDeliveryId}), so re-dispatching the same key re-sends the SAME
   * `id` the receiver dedupes on. Default: a fresh id per delivery.
   */
  idempotencyKey?: string
  /** Endpoint ids to skip (e.g. already delivered for this idempotency key). */
  skipEndpointIds?: Iterable<string>
}

/** Register/list subscriptions and dispatch events to matching endpoints. */
export class WebhookManager {
  private readonly tenancyActive: () => boolean
  private readonly now: () => number
  private readonly maxEndpointsPerDispatch: number
  private readonly dispatchConcurrency: number
  private readonly onFanOutExceeded: (info: WebhookFanOutExceeded) => void

  constructor(
    private readonly store: WebhookStore,
    private readonly deliverer: WebhookDeliverer,
    options: WebhookManagerOptions = {},
  ) {
    this.tenancyActive = options.tenancyActive ?? (() => false)
    this.now = options.now ?? Date.now
    const cap = options.maxEndpointsPerDispatch ?? DEFAULT_MAX_ENDPOINTS_PER_DISPATCH
    if (cap !== false) assertPositiveInteger('maxEndpointsPerDispatch', cap)
    this.maxEndpointsPerDispatch = cap === false ? Number.POSITIVE_INFINITY : cap
    this.dispatchConcurrency = options.dispatchConcurrency ?? DEFAULT_DISPATCH_CONCURRENCY
    assertPositiveInteger('dispatchConcurrency', this.dispatchConcurrency)
    this.onFanOutExceeded =
      options.onFanOutExceeded ??
      ((info) =>
        console.warn(
          `[basalt:webhooks] fan-out cap exceeded: ${info.endpoints} endpoints of ${info.tenantId === undefined ? 'the tenant-agnostic scope' : `tenant "${info.tenantId}"`} ` +
            `match "${info.event}" (limit ${info.limit}); none of them was sent to.`,
        ))
  }

  private allowsPort(port: number): boolean {
    const deliverer = this.deliverer as { allowsPort?: (port: number) => boolean }
    return typeof deliverer.allowsPort === 'function' ? deliverer.allowsPort(port) : isPortAllowed(port)
  }

  private requireScope(operation: string, tenantId: string | undefined, system: boolean | undefined): void {
    if (tenantId === undefined && !system && this.tenancyActive()) throw new WebhookTenantRequiredError(operation)
  }

  /** Refuses a caller-supplied endpoint id that already exists outside `tenantId`'s scope. */
  private async assertOwnId(id: string, tenantId: string | undefined): Promise<WebhookEndpoint | undefined> {
    if (tenantId !== undefined) {
      const own = (await this.store.list(tenantId)).find((e) => e.id === id && e.tenantId === tenantId)
      if (own) return own
    }
    const existing = (await this.store.list()).find((e) => e.id === id)
    if (existing && (existing.tenantId ?? undefined) !== tenantId) {
      throw new WebhookEndpointIdInUseError(id)
    }
    return existing
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
   *
   * The endpoint is validated before anything is stored: an unparseable URL, a
   * scheme outside the deliverer's allowlist, a secret shorter than
   * `MIN_WEBHOOK_SECRET_LENGTH` or an empty `events` list throws
   * {@link WebhookEndpointInvalidError}; an `id` held by another scope throws
   * {@link WebhookEndpointIdInUseError}.
   */
  async register(
    endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string },
    options: { system?: boolean } = {},
  ): Promise<WebhookEndpoint> {
    const tenantId = currentTenantId() ?? asTenantId(endpoint.tenantId)
    this.requireScope('register', tenantId, options.system)
    assertRegistrable(
      endpoint,
      (this.deliverer as { allowedSchemes?: readonly string[] }).allowedSchemes ?? DEFAULT_SCHEMES,
      (port) => this.allowsPort(port),
    )
    const { tenantId: _ignored, ...rest } = endpoint
    // A caller-supplied id upserts in every store: never let it replace an
    // endpoint that belongs to a different tenant (or a global one, when scoped).
    const existing = endpoint.id !== undefined ? await this.assertOwnId(endpoint.id, tenantId) : undefined
    const needsOwnSecret = tenantId !== undefined || !(this.deliverer as { hasDefaultSecret?: boolean }).hasDefaultSecret
    const secret = endpoint.secret ?? (needsOwnSecret ? generateWebhookSecret() : undefined)
    // Replacing an endpoint that is mid-rotation ends the rotation: re-registering
    // is how a leaked secret is revoked, so its predecessor must stop signing too.
    // (Keys set only then, so a store whose schema predates rotation is unaffected.)
    const endRotation = existing?.previousSecret != null && !('previousSecret' in endpoint)
    return this.store.add({
      ...rest,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(secret !== undefined ? { secret } : {}),
      ...(endRotation ? { previousSecret: undefined, previousSecretExpiresAt: undefined } : {}),
    })
  }

  /**
   * Rotates an endpoint's signing secret without breaking its receiver: the new
   * secret becomes current, and for `graceSeconds` (default 24 h) every delivery
   * is signed with BOTH — `t=…,v1=<new>,v1=<old>` — which `verifySignature` (and
   * Stripe-style receivers) accept with either secret. The receiver switches to
   * the new secret whenever it is ready; after the window only the new one signs.
   *
   * Returns the endpoint with its new `secret` (hand it to the customer now —
   * `list()` never returns secrets); the previous secret is not echoed back.
   * Scoped like {@link unregister}: an endpoint outside the ambient (or given)
   * tenant throws {@link WebhookEndpointNotFoundError}. An endpoint that signs
   * with the plugin-wide default secret has no own secret to rotate — rotate the
   * default in your configuration, or `register()` the endpoint with its own.
   * `graceSeconds: 0` is an immediate cut-over (e.g. after a leak).
   *
   * Durable stores must persist `previousSecret`/`previousSecretExpiresAt` (the
   * bundled SQLite and Prisma stores do; the Prisma schema needs the two
   * columns — see its README).
   */
  async rotateSecret(id: string, options: WebhookRotateSecretOptions = {}): Promise<WebhookEndpoint> {
    const tenantId = currentTenantId() ?? asTenantId(options.tenantId)
    this.requireScope('rotateSecret', tenantId, options.system)
    const grace = options.graceSeconds ?? DEFAULT_SECRET_ROTATION_GRACE_SECONDS
    if (!Number.isSafeInteger(grace) || grace < 0 || grace > MAX_SECRET_ROTATION_GRACE_SECONDS) {
      throw new WebhookEndpointInvalidError(
        `graceSeconds must be an integer from 0 to ${MAX_SECRET_ROTATION_GRACE_SECONDS} (got ${String(grace)})`,
        'rotateSecret',
      )
    }
    // Re-filtered here, like unregister: a store whose `list` ignores the tenant
    // can't hand one tenant another's endpoint.
    const existing =
      tenantId !== undefined
        ? (await this.store.list(tenantId)).find((e) => e.id === id && e.tenantId === tenantId)
        : (await this.store.list()).find((e) => e.id === id)
    if (!existing) throw new WebhookEndpointNotFoundError(id)
    const current = existing.secret
    if (current == null) {
      throw new WebhookEndpointInvalidError(
        'the endpoint signs with the plugin-wide default secret and has no own secret to rotate',
        'rotateSecret',
      )
    }
    const next = options.secret ?? generateWebhookSecret()
    if (typeof next !== 'string' || next.length < MIN_WEBHOOK_SECRET_LENGTH) {
      throw new WebhookEndpointInvalidError(`secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`, 'rotateSecret')
    }
    if (next === current) throw new WebhookEndpointInvalidError('the new secret must differ from the current one', 'rotateSecret')
    const { previousSecret: _previous, previousSecretExpiresAt: _expires, tenantId: ownerTenant, ...rest } = existing
    const owner = asTenantId(ownerTenant)
    const saved = await this.store.add({
      ...rest,
      ...(owner !== undefined ? { tenantId: owner } : {}),
      secret: next,
      // Always written (undefined clears), so a rotation also ends an earlier one.
      ...(grace > 0
        ? { previousSecret: current, previousSecretExpiresAt: new Date(this.now() + grace * 1000) }
        : { previousSecret: undefined, previousSecretExpiresAt: undefined }),
    })
    const { previousSecret: _omit, ...result } = saved
    return result
  }

  /**
   * Removes an endpoint, scoped to the ambient tenant (or `options.tenantId`):
   * a no-op for an endpoint another tenant owns. With tenancy active and no
   * tenant, `{ system: true }` is required.
   */
  async unregister(id: string, options: { tenantId?: string; system?: boolean } = {}): Promise<void> {
    const tenantId = currentTenantId() ?? asTenantId(options.tenantId)
    this.requireScope('unregister', tenantId, options.system)
    if (tenantId !== undefined) {
      // Re-verify ownership here instead of trusting the store to honour its
      // `tenantId` argument (a store that implements `remove(id)` only would let
      // one tenant delete another's endpoint). The result is re-filtered, so a
      // store whose `list` ignores the tenant can't widen it either. Fail closed:
      // not provably ours → no-op.
      const owned = (await this.store.list(tenantId)).some((e) => e.id === id && e.tenantId === tenantId)
      if (!owned) return
    }
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
    // Fan-out cap, per scope (a tenant, or the tenant-agnostic set): counted over
    // every matching endpoint — skipped ones included, so a retry sees the same
    // verdict as the first dispatch. An over-cap scope is refused whole.
    const perScope = new Map<string | undefined, number>()
    for (const endpoint of endpoints) {
      const scopeKey = asTenantId(endpoint.tenantId)
      perScope.set(scopeKey, (perScope.get(scopeKey) ?? 0) + 1)
    }
    const refused = new Set<string | undefined>()
    for (const [scopeKey, count] of perScope) {
      if (count <= this.maxEndpointsPerDispatch) continue
      refused.add(scopeKey)
      try {
        this.onFanOutExceeded({ event, tenantId: scopeKey, endpoints: count, limit: this.maxEndpointsPerDispatch })
      } catch (error) {
        console.error('[basalt:webhooks] onFanOutExceeded threw:', error)
      }
    }
    const skip = new Set(options.skipEndpointIds ?? [])
    const key = options.idempotencyKey
    // One endpoint's failure — even an unexpected throw (a malformed store row,
    // a resolver bug) — must never reject the whole dispatch and starve the rest.
    return mapPool(
      endpoints.filter((endpoint) => !skip.has(endpoint.id)),
      this.dispatchConcurrency,
      async (endpoint): Promise<DeliveryResult> => {
        if (refused.has(asTenantId(endpoint.tenantId))) {
          const error = `fan-out cap exceeded: more than ${this.maxEndpointsPerDispatch} endpoints of this scope subscribe to "${event}"`
          return { endpointId: endpoint.id, ok: false, attempts: 0, error, retryable: false }
        }
        try {
          return await this.deliverer.deliver(endpoint, event, data, key !== undefined ? { deliveryId: deriveDeliveryId(key, endpoint.id) } : {})
        } catch (error) {
          console.error(`[basalt:webhooks] delivery to endpoint "${endpoint.id}" threw:`, error)
          return { endpointId: endpoint.id, ok: false, attempts: 0, error: 'internal delivery error', retryable: true }
        }
      },
    )
  }
}

export const WEBHOOKS = createToken<WebhookManager>('webhooks')

export interface WebhooksPluginOptions extends WebhookDelivererOptions, WebhookFanOutOptions {
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
        ...(options.maxEndpointsPerDispatch !== undefined ? { maxEndpointsPerDispatch: options.maxEndpointsPerDispatch } : {}),
        ...(options.dispatchConcurrency !== undefined ? { dispatchConcurrency: options.dispatchConcurrency } : {}),
        ...(options.onFanOutExceeded !== undefined ? { onFanOutExceeded: options.onFanOutExceeded } : {}),
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
  type WebhookOutboxDispatchOptions,
} from './outbox.js'
