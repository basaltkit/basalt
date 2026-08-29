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
    webhooksPlugin({ secret: 'whsec_my_secret' }),
  ],
}).boot()
```

2. **Register an endpoint** (a subscription: the destination URL and the events it wants to receive):

```ts
import { WEBHOOKS } from '@basaltkit/webhooks'

const webhooks = app.container.get(WEBHOOKS)

await webhooks.register({
  url: 'https://client.example.com/hooks',
  events: ['invoice.*'],        // all events starting with "invoice."
  tenantId: 'acme',             // optional: only events for this tenant
})
```

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
x-basalt-signature: t=1712345678,v1=<hmac-sha256>

{"event":"invoice.paid","data":{"amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

5. **The recipient verifies the signature** with `verifySignature` (the same scheme as Stripe: HMAC-SHA256 over `timestamp.body`, rejecting old timestamps to prevent *replays*):

```ts
import { verifySignature } from '@basaltkit/webhooks'

// in an HTTP handler on the recipient's side:
const valid = verifySignature(signatureHeader, rawRequestBody, 'whsec_my_secret')
if (!valid) {
  // reject with 400
}
```

## Usage guide

### Event patterns

Each endpoint subscribes to a list of patterns (`events`):

- `'invoice.paid'` — only that exact event;
- `'invoice.*'` — any event starting with `invoice.`;
- `'*'` — all events.

You can test a pattern with `matchesEvent(['invoice.*'], 'invoice.paid') // true`.

### Per-tenant subscriptions

In a SaaS, each tenant (customer of your platform) registers its endpoints with its own `tenantId`. When dispatching with `dispatch(event, data, tenantId)`, only that tenant's endpoints and endpoints without a `tenantId` (global) receive it. An endpoint from tenant `acme` never receives events from tenant `globex`.

### Managing endpoints

```ts
const endpoint = await webhooks.register({ url: 'https://x.example.com/h', events: ['*'] })
await webhooks.list()          // all endpoints
await webhooks.list('acme')    // only tenant "acme"'s
await webhooks.unregister(endpoint.id)
```

To temporarily disable without deleting, save the endpoint with `active: false`.

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

The deliverer only retries transient failures — network errors, timeouts and `5xx` responses — with *exponential backoff* (a wait that doubles each attempt: 500 ms, 1 s, 2 s, ...). `4xx` responses are client errors and are **not** retried. The result of each delivery is a `DeliveryResult` with `ok`, `status`, `attempts` and `error`.

### Persistent store

`MemoryWebhookStore` loses everything on restart. In production, implement the `WebhookStore` interface over your database and pass it to the plugin:

```ts
import { webhooksPlugin, type WebhookStore, type WebhookEndpoint, matchesEvent } from '@basaltkit/webhooks'

class DbWebhookStore implements WebhookStore {
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT + matchesEvent */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* INSERT */ throw 0 }
  async remove(id: string): Promise<void> { /* DELETE */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT */ return [] }
}

webhooksPlugin({ store: new DbWebhookStore(), secret: 'whsec_...' })
```

## API reference

### `class WebhookManager`

`new WebhookManager(store: WebhookStore, deliverer: WebhookDeliverer)` — normally obtained via the `WEBHOOKS` token.

| Method | Signature | Description |
|---|---|---|
| `register` | `(endpoint: Omit<WebhookEndpoint,'id'> & { id?: string }) => Promise<WebhookEndpoint>` | Creates a subscription (id generated if omitted) |
| `unregister` | `(id: string) => Promise<void>` | Removes a subscription |
| `list` | `(tenantId?: string) => Promise<WebhookEndpoint[]>` | Lists subscriptions, optionally by tenant |
| `dispatch` | `(event: string, data: unknown, tenantId?: string) => Promise<DeliveryResult[]>` | Delivers to all endpoints subscribed to the event |

### `interface WebhookEndpoint`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `id` | `string` | Yes (generated) | UUID | Subscription identifier |
| `url` | `string` | Yes | — | Destination URL for the `POST` |
| `events` | `string[]` | Yes | — | Patterns: exact, prefix (`invoice.*`) or `*` |
| `tenantId` | `string` | No | — | Restricts to a tenant; omitted = receives from all |
| `secret` | `string` | No | deliverer's secret | This endpoint's signing secret |
| `active` | `boolean` | No | `true` | `false` disables without deleting |

### `webhooksPlugin(options?: WebhooksPluginOptions)`

Registers `WebhookManager` under the `WEBHOOKS` token. Extends `WebhookDelivererOptions` with:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `WebhookStore` | No | `MemoryWebhookStore` | Where subscriptions live |
| `deliverer` | `WebhookDeliverer` | No | new one, with the given options | Custom deliverer |
| `events` | `string[]` | No | `[]` | Domain event patterns to dispatch automatically (requires `@basaltkit/events`) |

### `class WebhookDeliverer`

`new WebhookDeliverer(options?: WebhookDelivererOptions)`. Method: `deliver(endpoint, event, data) => Promise<DeliveryResult>`.

`WebhookDelivererOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `secret` | `string` | No | — | Default signing secret (the endpoint's `secret` overrides it) |
| `maxRetries` | `number` | No | `3` | Retries after the first attempt |
| `backoffMs` | `number` | No | `500` | Base wait in ms, doubled per attempt |
| `timeoutMs` | `number` | No | `10000` | Timeout per attempt in ms |
| `fetchImpl` | `typeof fetch` | No | global `fetch` | (Advanced) injectable fetch, for tests |
| `sleep` | `(ms) => Promise<void>` | No | `setTimeout` | (Advanced) injectable wait, for tests |
| `now` | `() => number` | No | real clock | (Advanced) clock in seconds, for tests |

`DeliveryResult`: `{ endpointId: string, ok: boolean, status?: number, attempts: number, error?: string }`.

### Signature functions

| Function | Signature | Description |
|---|---|---|
| `signPayload` | `(body: string, secret: string, timestampSeconds: number) => string` | Generates the `t=<unix>,v1=<hmac-sha256>` header |
| `verifySignature` | `(header: string, body: string, secret: string, toleranceSeconds = 300, nowSeconds?) => boolean` | Verifies in constant time; rejects timestamps outside the tolerance |
| `matchesEvent` | `(patterns: string[], event: string) => boolean` | Tests whether an event matches the patterns |

### Other exports

| Export | Type | Description |
|---|---|---|
| `WEBHOOKS` | token | Key for `WebhookManager` in the container |
| `MemoryWebhookStore` | class | In-memory store (dev/tests) |
| `WebhookStore` | type (Advanced) | Contract for persistent stores |

## Common errors and solutions (FAQ)

**The recipient says the signature is invalid** — They need to verify the HMAC over the **raw body** of the request, byte for byte. If they `JSON.parse` and re-serialize, the bytes change and verification fails. Also confirm both sides use the same secret.

**`verifySignature` returns `false` even though everything looks right** — Check the clock: the signature expires after `toleranceSeconds` (300s by default). Out-of-sync clocks between servers cause rejections.

**Delivery failed with `ok: false` and `status: 4xx` with no retries** — Correct behavior: `4xx` means an error on the recipient's side (wrong URL, authentication), and retrying wouldn't fix it. Only `5xx` and network errors are retried.

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
