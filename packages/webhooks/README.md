<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/webhooks

Outbound webhooks for the Basalt framework: deliver events from your application to other systems' URLs, with cryptographic signing, automatic retries and per-tenant subscriptions. You need this module when *your customers* (or other services) want to be notified over HTTP when something happens in your application.

## What this module solves

A **webhook** is an HTTP "callback": instead of another system constantly asking "anything new?", your application makes a `POST` request to that system's URL the moment something happens (e.g. "invoice paid"). This is how services like Stripe or GitHub notify their users' applications — this module gives you the same thing, but outbound: your application notifying third parties.

Doing this by hand looks like a simple `fetch`, but the problems show up fast: the destination server may be down (you need retries with growing intervals), the recipient needs to be sure the request really came from you (HMAC signing — a code computed with a shared secret that proves origin and detects tampering), each customer wants to subscribe to only some events, and in a multi-tenant SaaS each tenant should only receive its own events.

The module splits this into three pieces: the **store** (where subscriptions live — in-memory by default, database in production), the **deliverer** (makes the signed `POST` with retries and exponential backoff) and the **manager** (ties the two together: when dispatching an event, it finds the subscribed endpoints and delivers to each one). Optionally, it hooks into `@basaltkit/events` to automatically dispatch domain events.

## Installation

```bash
pnpm add @basaltkit/webhooks
```

## Getting started in 5 minutes

1. **Register the plugin** in the application:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    // Default secret (min 16 chars) — signs tenant-agnostic endpoints only.
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()
```

Deliveries are never sent unsigned by default: with no secret at all a delivery is refused (`allowUnsigned: true` opts out).

2. **Register an endpoint** (a subscription: the destination URL and the events it wants to receive):

```ts
import { WEBHOOKS } from '@basaltkit/webhooks'

const webhooks = app.container.get(WEBHOOKS)

const endpoint = await webhooks.register({
  url: 'https://client.example.com/hooks',
  events: ['invoice.*'],        // all events starting with "invoice."
  tenantId: 'acme',             // forced from ctx() when a tenant is in context
})
endpoint.secret // per-endpoint signing secret (whsec_…), generated and returned ONCE
```

Every tenant endpoint gets its **own** signing secret (generated when you don't pass one), so one tenant can never forge webhooks another tenant's receiver accepts. A tenant endpoint with only the plugin-wide secret is refused (`allowSharedSecret: true` opts out).

3. **Dispatch an event.** Each subscribed endpoint receives a `POST` with signed JSON:

```ts
const results = await webhooks.dispatch('invoice.paid', { amount: 42 }, 'acme')
console.log(results)
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

4. **What the recipient receives** — a `POST` with these headers and body:

```
content-type: application/json
x-basalt-event: invoice.paid
x-basalt-delivery: <uuid>
x-basalt-signature: t=1712345678,v1=<hmac-sha256>

{"id":"<uuid>","event":"invoice.paid","endpointId":"<endpoint id>","data":{"amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

`id` is unique per delivery (stable across its retries) and is signed — dedupe on it. Through the webhook outbox (or `dispatch(event, data, { idempotencyKey })`) it is derived from the outbox entry id and the endpoint id, so it also stays the same across outbox retries and restarts. Each attempt is signed with its own timestamp `t`, so a retry after a long backoff still passes the receiver's tolerance.

5. **The recipient verifies the signature** with `verifySignature` (the same scheme as Stripe: HMAC-SHA256 over `timestamp.body`, rejecting old timestamps to prevent *replays*):

```ts
import { verifySignature } from '@basaltkit/webhooks'

// in an HTTP handler on the recipient's side:
// the secret register() returned for THIS endpoint (a secret under 16 chars always fails)
// (a toleranceSeconds that is NaN/negative/infinite throws a RangeError — it would disable replay protection)
const valid = verifySignature(signatureHeader, rawRequestBody, endpointSecret)
if (!valid) {
  // reject with 400
}
```

The header may carry several `v1=` signatures: during a secret rotation (`rotateSecret()`, below) the sender signs with both the new and the old secret. `verifySignature` returns `true` when **any** of them matches your secret.

## Usage guide

### Event patterns

Each endpoint subscribes to a list of patterns (`events`):

- `'invoice.paid'` — only that exact event;
- `'invoice.*'` — any event starting with `invoice.`;
- `'*'` — all events.

You can test a pattern with `matchesEvent(['invoice.*'], 'invoice.paid') // true`.

### Per-tenant subscriptions

In a SaaS, each tenant (customer of your platform) registers its endpoints with its own `tenantId`. When dispatching with `dispatch(event, data, tenantId)`, only that tenant's endpoints and endpoints without a `tenantId` (global) receive it. An endpoint from tenant `acme` never receives events from tenant `globex`.

A dispatch with **no** tenant (no tenant in context, none passed — e.g. a scheduler job) reaches only global endpoints, never a tenant-bound one. A deliberate broadcast to every tenant opts in: `dispatch(event, data, { allTenants: true })`. With `tenancyPlugin` active, `register` / `list` / `unregister` without any tenant throw `WebhookTenantRequiredError` unless called with `{ system: true }`.

### Managing endpoints

```ts
const endpoint = await webhooks.register({ url: 'https://x.example.com/h', events: ['*'] })
await webhooks.list()          // all endpoints (secrets redacted: `hasSecret` instead)
await webhooks.list('acme')    // only tenant "acme"'s
await webhooks.unregister(endpoint.id)
```

To temporarily disable without deleting, save the endpoint with `active: false`.

`register()` refuses a URL whose port the deliverer would never send to (see [Port policy](#port-policy)) with `WebhookEndpointInvalidError`.

### Rotating a signing secret

`rotateSecret()` replaces an endpoint's secret **without breaking its receiver**. For a grace window (default 24 h), every delivery is signed with both secrets, `t=…,v1=<new>,v1=<old>`. A receiver on either secret keeps verifying, so it can switch whenever it is ready:

```ts
const { secret } = await webhooks.rotateSecret(endpoint.id, { graceSeconds: 7 * 86_400 })
// hand `secret` to the customer; the old one stops signing after 7 days
```

- `graceSeconds`: from 0 to 30 days. `0` is an immediate cut-over, e.g. after a leak.
- `secret`: pass your own (min 16 chars); otherwise one is generated.
- Scoping works like `unregister`. An endpoint outside the tenant throws `WebhookEndpointNotFoundError` (404).
- An endpoint signing with the plugin-wide default secret has no own secret to rotate. Rotate the default in configuration instead.
- Re-registering the endpoint (same `id`) ends a rotation in progress.
- `list()` never returns either secret.

Durable stores keep the previous secret in `previousSecret` / `previousSecretExpiresAt`. `webhooks-sqlite` migrates the columns itself; `webhooks-prisma` needs them in your schema.

### Automatic dispatch from domain events

With `@basaltkit/events` registered, pass `events` to the plugin and every domain event matching the patterns is dispatched automatically — with the tenant read from the request context and in *fire-and-forget* mode (whoever emits the event never blocks waiting for the HTTP call):

```ts
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { webhooksPlugin } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ secret: 'whsec_...', events: ['invoice.*'] }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
// → delivered to all endpoints subscribed to "invoice.*"
```

### Retries and failures

The deliverer only retries transient failures — network errors, timeouts and `5xx` responses — with *exponential backoff* (a wait that doubles each attempt: 500 ms, 1 s, 2 s, ...). `4xx` responses are client errors and are **not** retried. The result of each delivery is a `DeliveryResult` with `ok`, `status`, `attempts`, `error` and — on failures — `retryable` (`true` for network/timeout/`5xx`/`408`/`429`, `false` for SSRF-blocked URLs, redirects, other `4xx` and refused secrets). One endpoint's delivery throwing unexpectedly never rejects the whole `dispatch`: it becomes a failed result (`internal delivery error`).

`timeoutMs` is one deadline per attempt that covers **resolving the host and the request together**. A DNS server that never answers fails the attempt (`host resolution timed out`, retryable), and the next attempt resolves again.

### Fan-out limits

A `dispatch` sends to at most `dispatchConcurrency` endpoints at once (default 16). It also refuses a scope (one tenant, or the tenant-agnostic endpoints) with more than `maxEndpointsPerDispatch` active endpoints subscribed to the event (default 100). None of that scope's endpoints is sent to — picking some of them would be arbitrary. Each gets a failed result `fan-out cap exceeded…` (`retryable: false`), and `onFanOutExceeded({ event, tenantId, endpoints, limit })` is called once for alerting (default `console.warn`). Other tenants in the same dispatch are unaffected. `maxEndpointsPerDispatch: false` disables the cap.

```ts
webhooksPlugin({ secret, maxEndpointsPerDispatch: 25, dispatchConcurrency: 8, onFanOutExceeded: (i) => metrics.increment('webhooks.fanout_refused', i) })
```

### Port policy

A delivery goes only to port `80`, `443`, or a port from `1024` up that is not in `DEFAULT_BLOCKED_PORTS`. That list covers ports registered to databases, caches, message brokers, cluster control planes, proxies and remote-admin services: Redis `6379`, memcached `11211`, Postgres `5432`, MySQL `3306`, MongoDB `27017`, Docker `2375`, kubelet `10250`, and so on. Other privileged ports (`22`, `25`, …) are refused. Those services never receive webhooks, and several speak text protocols that a crafted `POST` body can drive — even on a public host, where the private-address guard does not help. Set `ssrf.allowedPorts` to change the policy:

```ts
webhooksPlugin({ secret, ssrf: { allowedPorts: [443] } })     // exactly these ports
webhooksPlugin({ secret, ssrf: { allowedPorts: 'any' } })     // policy off
```

The port is checked before any DNS lookup, also with `allowPrivateHosts`, at `register()` and on every delivery. A blocked port is a permanent failure (`attempts: 0`, `retryable: false`). Redirects are never followed, so a `3xx` can't reach a blocked port either.

The webhook outbox (`webhookOutboxDispatch`) re-queues an entry only for **retryable** failures, skips endpoints that already accepted it, and re-sends the same delivery `id`. Permanent failures go to `onPermanentFailure` (default `console.warn`) instead of re-delivering to healthy endpoints.

A URL blocked on a DNS verdict (the host doesn't resolve, or resolves to a private address) reports one generic `error` with no address, so whoever registers endpoints can't map your internal DNS; the address is on `WebhookUrlBlockedError.resolvedAddress` for server-side logs.

### Persistent store

`MemoryWebhookStore` loses everything on restart. In production, implement the `WebhookStore` interface over your database and pass it to the plugin:

```ts
import { webhooksPlugin, type WebhookStore, type WebhookEndpoint, matchesEvent } from '@basaltkit/webhooks'

class DbWebhookStore implements WebhookStore {
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT + matchesEvent */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* INSERT */ throw 0 }
  // DELETE … WHERE id = ? [AND tenant_id = ?] — with a tenantId, only if that tenant owns it
  async remove(id: string, tenantId?: string): Promise<void> { /* DELETE */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT */ return [] }
}

webhooksPlugin({ store: new DbWebhookStore(), secret: 'whsec_...' })
```

`add()` must refuse an `id` that another scope already holds (another tenant, or a global endpoint vs a tenant one) — throw `WebhookEndpointIdInUseError` — and replace only within the same scope. Do it in the write itself (`UPDATE … WHERE id = ? AND tenant_id IS ?`, then `INSERT`): the manager's own pre-check cannot close the race between two concurrent registrations.

`remove(id, tenantId)` must only delete an endpoint that tenant owns (the manager also re-checks ownership through `list(tenantId)` before calling it). Rows may carry `null` for an absent `secret` / `tenantId` — the deliverer treats `null` as absent.

`forEvent` must **fail closed**: with a `tenantId`, return that tenant's endpoints plus tenant-agnostic ones; with no tenant (`undefined`, `null` or `''`), return tenant-agnostic endpoints **only** — never every tenant's. A deliberate `dispatch(event, data, { allTenants: true })` reads endpoints through `list()` instead, and the manager re-filters every result, so a store that gets this wrong still can't widen delivery.

## API reference

### `class WebhookManager`

`new WebhookManager(store: WebhookStore, deliverer: WebhookDeliverer)` — normally obtained via the `WEBHOOKS` token.

| Method | Signature | Description |
|---|---|---|
| `register` | `(endpoint: Omit<WebhookEndpoint,'id'> & { id?: string }, options?: { system?: boolean }) => Promise<WebhookEndpoint>` | Creates a subscription (id generated if omitted). Validates first: an unparseable URL, a scheme the deliverer refuses, a `secret` under 16 chars or empty `events` throw `WebhookEndpointInvalidError` (400); an `id` held by another scope throws `WebhookEndpointIdInUseError` (409) |
| `unregister` | `(id: string, options?: { tenantId?: string; system?: boolean }) => Promise<void>` | Removes a subscription — a no-op unless the (ambient or given) tenant owns it |
| `list` | `(tenantId?: string) => Promise<WebhookEndpointView[]>` | Lists subscriptions, optionally by tenant (both secrets redacted) |
| `rotateSecret` | `(id: string, options?: { graceSeconds?, secret?, tenantId?, system? }) => Promise<WebhookEndpoint>` | New secret; the old one keeps signing alongside it for `graceSeconds` (default 86400, max 30 days, `0` = immediate). Returns the new `secret` |
| `dispatch` | `(event: string, data: unknown, scope?: string \| { tenantId?, allTenants?, idempotencyKey?, skipEndpointIds? }) => Promise<DeliveryResult[]>` | Delivers to all endpoints subscribed to the event, at most `dispatchConcurrency` at once; a scope over `maxEndpointsPerDispatch` is refused whole; `idempotencyKey` derives stable delivery ids |

### `interface WebhookEndpoint`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `id` | `string` | Yes (generated) | UUID | Subscription identifier |
| `url` | `string` | Yes | — | Destination URL for the `POST` |
| `events` | `string[]` | Yes | — | Patterns: exact, prefix (`invoice.*`) or `*` |
| `tenantId` | `string` | No | — | Restricts to a tenant; omitted = receives from all |
| `secret` | `string` | No | deliverer's secret | This endpoint's signing secret |
| `active` | `boolean` | No | `true` | `false` disables without deleting |
| `previousSecret` | `string` | No | — | Set by `rotateSecret()`: the replaced secret, still signing until `previousSecretExpiresAt` |
| `previousSecretExpiresAt` | `Date` | No | — | End of the rotation grace window (a `previousSecret` without it is ignored) |

### `webhooksPlugin(options?: WebhooksPluginOptions)`

Registers `WebhookManager` under the `WEBHOOKS` token. Extends `WebhookDelivererOptions` with:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `WebhookStore` | No | `MemoryWebhookStore` | Where subscriptions live |
| `deliverer` | `WebhookDeliverer` | No | new one, with the given options | Custom deliverer |
| `events` | `string[]` | No | `[]` | Domain event patterns to dispatch automatically (requires `@basaltkit/events`) |
| `maxEndpointsPerDispatch` | `number \| false` | No | `100` | Most endpoints of one scope (tenant, or tenant-agnostic) per event; over it, that scope is refused whole |
| `dispatchConcurrency` | `number` | No | `16` | Deliveries one `dispatch` runs at once |
| `onFanOutExceeded` | `(info) => void` | No | `console.warn` | Called once per refused scope, with `{ event, tenantId, endpoints, limit }` |

### `class WebhookDeliverer`

`new WebhookDeliverer(options?: WebhookDelivererOptions)`. Method: `deliver(endpoint, event, data) => Promise<DeliveryResult>`.

`WebhookDelivererOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `secret` | `string` | No | — | Default signing secret (the endpoint's `secret` overrides it) |
| `maxRetries` | `number` | No | `3` | Retries after the first attempt |
| `backoffMs` | `number` | No | `500` | Base wait in ms, doubled per attempt |
| `timeoutMs` | `number` | No | `10000` | Deadline per attempt in ms, covering DNS resolution and the request |
| `ssrf` | `SsrfGuardOptions \| false` | No | on | `{ allowPrivateHosts?, allowedSchemes?, allowedPorts?, lookup? }` — see [Port policy](#port-policy); `false` disables the guard |
| `fetchImpl` | `typeof fetch` | No | built-in **pinned** transport (not global `fetch`) | (Advanced) injectable HTTP client. It gets the validated IP under `init[PINNED_ADDRESS]`, which plain `fetch` ignores — delegate to `pinnedFetch` to keep DNS-rebind protection. Otherwise a one-time `BASALT_WEBHOOKS_UNPINNED_FETCH` warning is emitted and the host is re-validated before every retry (narrows, doesn't close, the rebind window) |
| `fetchImplPinsAddress` | `boolean` | No | `false` | Declares that `fetchImpl` honours `PINNED_ADDRESS` (e.g. wraps `pinnedFetch`); silences the warning |
| `sleep` | `(ms) => Promise<void>` | No | `setTimeout` | (Advanced) injectable wait, for tests |
| `now` | `() => number` | No | real clock | (Advanced) clock in seconds, for tests |

`DeliveryResult`: `{ endpointId: string, ok: boolean, status?: number, attempts: number, error?: string, retryable?: boolean }`.

Keeping pinning with an instrumented client:

```ts
import { pinnedFetch, WebhookDeliverer } from '@basaltkit/webhooks'

new WebhookDeliverer({
  secret: process.env.WEBHOOK_SECRET,
  fetchImpl: async (url, init) => { console.time('hook'); try { return await pinnedFetch(url, init) } finally { console.timeEnd('hook') } },
  fetchImplPinsAddress: true,
})
```

Rewriting the URL host to the validated IP is not an option for plain `fetch`: it can't set TLS SNI separately, so `https` certificate validation would fail.

### Signature functions

| Function | Signature | Description |
|---|---|---|
| `signPayload` | `(body: string, secret: string \| string[], timestampSeconds: number) => string` | Generates the `t=<unix>,v1=<hmac-sha256>` header — one `v1` per secret when given several |
| `verifySignature` | `(header: string, body: string, secret: string, toleranceSeconds = 300, nowSeconds?) => boolean` | Verifies in constant time; `true` if any `v1` matches (secret rotation); rejects timestamps outside the tolerance; throws `RangeError` if `toleranceSeconds` isn't a finite number ≥ 0 or `nowSeconds` isn't finite |
| `matchesEvent` | `(patterns: string[], event: string) => boolean` | Tests whether an event matches the patterns |

### Other exports

| Export | Type | Description |
|---|---|---|
| `WEBHOOKS` | token | Key for `WebhookManager` in the container |
| `MemoryWebhookStore` | class | In-memory store (dev/tests); `add()` refuses an id held by another scope |
| `WebhookEndpointInvalidError` | class | `WEBHOOK_ENDPOINT_INVALID` (400) — `register()` refused an undeliverable endpoint |
| `WebhookEndpointIdInUseError` | class | `WEBHOOK_ENDPOINT_ID_IN_USE` (409) — the id belongs to another scope |
| `WebhookEndpointNotFoundError` | class | `WEBHOOK_ENDPOINT_NOT_FOUND` (404) — `rotateSecret()` found no such endpoint in scope |
| `DEFAULT_BLOCKED_PORTS` | `readonly number[]` | Ports the default port policy refuses at or above 1024 |
| `isPortAllowed` | function | `(port, allowedPorts?) => boolean` — the port policy |
| `WebhookStore` | type (Advanced) | Contract for persistent stores |
| `pinnedFetch` | function | `fetch`-compatible client over the pinned transport (honours `PINNED_ADDRESS`) |
| `deriveDeliveryId` | function | `(idempotencyKey, endpointId) => string` — the stable delivery id used by the outbox |
| `webhookOutboxDispatch` | function | `(webhooks, { onPermanentFailure?, maxTrackedEntries? }?) => OutboxDispatch` |

## Common errors and solutions (FAQ)

**The recipient says the signature is invalid** — They need to verify the HMAC over the **raw body** of the request, byte for byte. If they `JSON.parse` and re-serialize, the bytes change and verification fails. Also confirm both sides use the same secret.

**`verifySignature` returns `false` even though everything looks right** — Check the clock: the signature expires after `toleranceSeconds` (300s by default). Out-of-sync clocks between servers cause rejections.

**Delivery failed with `ok: false` and `status: 4xx` with no retries** — Correct behavior: `4xx` means an error on the recipient's side (wrong URL, authentication), and retrying wouldn't fix it. Only `5xx` and network errors are retried.

**Delivery fails with `port N is not allowed`** — The endpoint's port is outside the port policy. If the receiver really listens there, allow it with `ssrf: { allowedPorts: [...] }`.

**Every endpoint of a tenant fails with `fan-out cap exceeded`** — That tenant has more than `maxEndpointsPerDispatch` endpoints subscribed to the event. Remove duplicates, or raise the cap.

**Subscriptions disappear when the application restarts** — You're on `MemoryWebhookStore` (the default). In production, implement `WebhookStore` over your database.

**I configured `events` on the plugin but nothing is dispatched** — Automatic dispatch requires `eventsPlugin()` from `@basaltkit/events` to be registered (the plugin declares that dependency). Also confirm the patterns in `events` cover the emitted event names, and that at least one endpoint is subscribed.

**Automatic `dispatch` doesn't filter by tenant** — The tenant is read from the request context (`ctx().tenant.id`). Outside a request (e.g. in a job), there's no tenant in the context and the event also goes to global endpoints; in that case, dispatch manually with `webhooks.dispatch(event, data, tenantId)`.

## Tenant scoping (anti-widening)

With a tenant in the ambient request context, `register`, `list`, `unregister`
and `dispatch` are forced to that tenant — a caller-supplied `tenantId` can
never widen the scope. Explicit arguments / system-wide behavior apply only
with no ambient tenant (jobs, CLI, single-tenant apps).

## How it connects to other modules

- **@basaltkit/core** — the container (`WEBHOOKS` token), `definePlugin` and the request context from which `tenantId` comes during automatic dispatch.
- **@basaltkit/events** — the source of domain events; with the `events` option, the plugin subscribes to the bus and converts internal events into outbound webhooks.
- **@basaltkit/subscriptions** — the opposite direction: subscriptions *receives* webhooks (from Stripe); this module *sends* webhooks to your customers. A common pattern is forwarding `billing:*` hooks as outbound webhooks.
- **@basaltkit/notifications** — complementary: notifications alerts people, webhooks alerts machines.
