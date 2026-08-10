# Webhooks

`@basaltkit/webhooks` delivers **outbound** webhooks: signed payloads, retries with
backoff, per-tenant subscriptions, and automatic dispatch from your domain
events. Three pieces work together — a **store** (where subscriptions live), a
**deliverer** (signs and `POST`s with retries), and a **manager** (finds the
subscribed endpoints for an event and delivers to each).

[[toc]]

## Setup

`webhooksPlugin` registers a `WebhookManager` under the `WEBHOOKS` token. The
only required-ish option is a default signing `secret`:

```ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin, WEBHOOKS } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()

const hooks = app.container.get(WEBHOOKS)
```

## Managing subscriptions

An **endpoint** is a subscription: a destination URL plus the event patterns it
wants. Register, list and remove them through the manager:

```ts
const endpoint = await hooks.register({
  url: 'https://customer.example.com/hooks',
  events: ['invoice.*', 'user.created'], // patterns: exact, prefix `x.*`, or `*`
  tenantId: 'acme',        // omit to receive events from every tenant (global)
  secret: 'whsec_acme_...',// optional per-endpoint secret (overrides the default)
  active: true,            // set false to disable without deleting
})

await hooks.list()          // every endpoint
await hooks.list('acme')    // only tenant "acme"'s endpoints
await hooks.unregister(endpoint.id)
```

Event patterns match like this:

- `'invoice.paid'` — that exact event only
- `'invoice.*'` — any event starting with `invoice.`
- `'*'` — every event

```ts
import { matchesEvent } from '@basaltkit/webhooks'
matchesEvent(['invoice.*'], 'invoice.paid') // true
```

## Dispatching events

`dispatch(event, data, tenantId?)` finds every subscribed endpoint (the tenant's
own plus global ones) and delivers a signed `POST` to each, returning one
`DeliveryResult` per endpoint:

```ts
const results = await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 }, 'acme')
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

Each result is `{ endpointId, ok, status?, attempts, error? }` — persist it for
an audit trail.

### What the recipient receives

```
content-type: application/json
x-basalt-event: invoice.paid
x-basalt-signature: t=1712345678,v1=<hmac-sha256(t.body)>

{"event":"invoice.paid","data":{"id":"in_1","amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

## Auto-dispatch from domain events

Wire the bus once and matching domain events fan out to subscribed endpoints
automatically — tenant-scoped from the request context and fire-and-forget, so
the emitter never blocks on HTTP. This requires `@basaltkit/events`:

```ts
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { webhooksPlugin } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({
      secret: process.env.WEBHOOK_SECRET,
      events: ['invoice.*', 'user.created'], // domain events to forward
    }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
// → delivered to every endpoint subscribed to "invoice.*"
```

::: warning
Auto-dispatch needs `eventsPlugin()` registered — the plugin declares that
dependency. The tenant comes from `ctx().tenant.id`; when you emit outside a
request (e.g. in a job) there's no tenant in context, so the event reaches only
**global** endpoints. Dispatch manually with an explicit `tenantId` when you need
tenant scoping off the request path.
:::

## Signing & verification

Each delivery carries `X-Basalt-Signature: t=<unix>,v1=<hmac-sha256(t.body)>` —
the same scheme Stripe uses. Receivers recompute the HMAC over `timestamp.body`
and compare in constant time, rejecting stale timestamps to prevent replay:

```ts
import { verifySignature } from '@basaltkit/webhooks'

// in your receiver, over the RAW request body (not a re-serialized object):
const valid = verifySignature(
  req.headers['x-basalt-signature'] as string,
  rawBody,
  process.env.WEBHOOK_SECRET!,
  300, // tolerance in seconds (default) — rejects timestamps older than this
)
if (!valid) return res.status(400).end()
```

::: warning Verify over the raw body
The HMAC is computed over the exact bytes sent. If your framework parses JSON and
you re-`JSON.stringify` it, the bytes change and verification fails. Capture the
raw body (e.g. Express `express.raw()`) before parsing.
:::

`signPayload(body, secret, timestampSeconds)` produces the same header if you
need to sign manually.

## Delivery semantics

- Transient failures (`5xx`, network errors, timeouts) retry with exponential
  backoff — `500ms`, `1s`, `2s`, … up to `maxRetries` (default `3`).
- Client errors (`4xx`) are **not** retried — a wrong URL or auth won't fix
  itself on retry.
- Tune the deliverer through the plugin options (they pass straight through to
  the `WebhookDeliverer`):

```ts
webhooksPlugin({
  secret: process.env.WEBHOOK_SECRET,
  maxRetries: 5,     // retries after the first attempt (default 3)
  backoffMs: 500,    // base wait, doubled each attempt (default 500)
  timeoutMs: 10_000, // per-attempt timeout (default 10s)
})
```

For durable, distributed retries that survive a restart mid-delivery, drive
`dispatch()` from `@basaltkit/queue` instead of relying on the in-process retry
loop — see [Queues & jobs](/guide/queues).

## Durable subscription stores

The default `MemoryWebhookStore` forgets every endpoint on restart — after a
redeploy nobody is subscribed and events silently stop. In production, swap in a
durable store. The `WebhookStore` contract is identical across backends, so it's
a one-line change.

### SQLite (single node, zero dependencies)

`@basaltkit/webhooks-sqlite` persists subscriptions in a local file over Node's
built-in `node:sqlite` (Node 22.5+; flag-free on Node 24).

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'

const webhooks = sqliteWebhookStore('./data/webhooks.db') // ':memory:' by default

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`sqliteWebhookStore()` opens (or creates) the database, applies an idempotent
schema, and returns `{ store, db }` — the raw `db` handle is exposed if you need
it.

### Prisma (Postgres/MySQL, multi-instance)

`@basaltkit/webhooks-prisma` shares one set of subscriptions across instances on
the database you already run. Bring your own `PrismaClient`; the package ships a
reference model.

```bash
pnpm add @basaltkit/webhooks @basaltkit/webhooks-prisma
pnpm basalt prisma:sync --push   # add the WebhookEndpoint model + create the table
```

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { prismaWebhookStore } from '@basaltkit/webhooks-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const webhooks = prismaWebhookStore(prisma)

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`prisma:sync` discovers every installed `@basaltkit/*-prisma` package and merges
its models into your `schema.prisma`. Wire the store before its model exists and
it fails fast, naming the missing model — see [Persistence](/guide/persistence).

### Which backend?

| Store | Package | Use when |
| --- | --- | --- |
| Memory | `@basaltkit/webhooks` | Dev and tests (lost on restart) |
| SQLite | `@basaltkit/webhooks-sqlite` | A single node, zero dependencies, local file |
| Prisma | `@basaltkit/webhooks-prisma` | Postgres/MySQL, multiple instances share subscriptions |

### Writing your own store

Implement the `WebhookStore` contract — four methods — over any backend:

```ts
import { type WebhookStore, type WebhookEndpoint, matchesEvent } from '@basaltkit/webhooks'

class MyWebhookStore implements WebhookStore {
  // active, tenant-scoped, event-pattern matched (use matchesEvent)
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* … */ throw 0 }
  async remove(id: string): Promise<void> { /* … */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
}

webhooksPlugin({ store: new MyWebhookStore(), secret: process.env.WEBHOOK_SECRET })
```

## See also

- [Queues & jobs](/guide/queues) — drive delivery from a queue for durable retries.
- [Multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas) — per-tenant endpoints in a real app.
