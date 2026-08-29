# Webhooks

`@basaltkit/webhooks` delivers **outbound** webhooks: signed payloads, retries
with backoff, per-tenant subscriptions, and automatic dispatch from your domain
events. It is decoupled from your domain — nothing in your code needs to know an
endpoint exists — and from the transport, because delivery is a plain signed
`POST` any receiver can verify.

[[toc]]

## Mental model

Three pieces, each replaceable:

| Piece | Contract | What it does |
| --- | --- | --- |
| **Store** | `WebhookStore` | Where subscriptions live. Answers "who wants `invoice.paid` for tenant `acme`?" |
| **Deliverer** | `WebhookDeliverer` | Signs the body, validates the URL against SSRF, `POST`s it, retries transient failures |
| **Manager** | `WebhookManager` (token `WEBHOOKS`) | Register/list/unregister endpoints, and `dispatch(event, data)` to every match |

`dispatch` is the whole flow: the manager asks the store for the endpoints
matching the event *and* the tenant, then hands each one to the deliverer and
returns one `DeliveryResult` per endpoint. Nothing is persisted about the
attempt — if you need an audit trail, store the results yourself; if you need
delivery to survive a crash, use the outbox (below).

Tenant scoping is **anti-widening** throughout: an ambient `ctx().tenant.id`
always wins over a caller-supplied `tenantId`, so client input can never widen
or switch the scope.

## Quickstart

`webhooksPlugin` registers a `WebhookManager` under the `WEBHOOKS` token. The
only near-required option is a default signing `secret`:

```ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin, WEBHOOKS } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()

const hooks = app.container.get(WEBHOOKS)

await hooks.register({ url: 'https://customer.example.com/hooks', events: ['invoice.*'] })
await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 })
```

Without a `secret` (and without a per-endpoint one) deliveries go out
**unsigned** — no `x-basalt-signature` header at all, so receivers have no way
to tell your call from anyone else's. Set it.

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

await hooks.list()          // every endpoint (no tenant in context)
await hooks.list('acme')    // only tenant "acme"'s endpoints
await hooks.unregister(endpoint.id)
```

Scoping is **anti-widening**: inside a request with a tenant in context,
`register`, `list`, `unregister` and `dispatch` are forced to that tenant — a
caller-supplied `tenantId` (which may carry client input) can never widen or
switch the scope. The explicit argument and the system-wide behavior above apply
only where there is no ambient tenant (jobs, CLI, single-tenant apps).
`unregister` is a no-op — not an error — for an endpoint owned by another
tenant.

Event patterns match like this:

- `'invoice.paid'` — that exact event only
- `'invoice.*'` — any event starting with `invoice.`
- `'*'` or `'**'` — every event

```ts
import { matchesEvent } from '@basaltkit/webhooks'
matchesEvent(['invoice.*'], 'invoice.paid') // true
```

Only `active !== false` endpoints receive deliveries; flipping `active` to
`false` is the reversible way to stop a flapping customer endpoint.

## Dispatching events

`dispatch(event, data, tenantId?)` finds every subscribed endpoint (the tenant's
own plus global ones) and delivers a signed `POST` to each, returning one
`DeliveryResult` per endpoint:

```ts
const results = await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 }, 'acme')
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

Each result is `{ endpointId, ok, status?, attempts, error? }` — persist it for
an audit trail. Deliveries run in parallel and `dispatch` resolves only when all
of them have settled, so an endpoint that eats the full retry budget delays the
whole call: `dispatch` from a job or the outbox rather than inline in a request
handler.

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
dependency when `events` is non-empty. The tenant comes from `ctx().tenant.id`;
when you emit outside a request (e.g. in a job) there's no tenant in context, so
the event reaches only **global** endpoints. Dispatch manually with an explicit
`tenantId` when you need tenant scoping off the request path.
:::

Fire-and-forget also means **silent**: the listener does `void dispatch(...)`,
so a failed delivery never reaches the emitter and nothing retries after the
in-process budget is spent. That is the trade — see the outbox below when losing
an event is not acceptable.

## Durable integration events (outbox)

Auto-dispatch above is **fire-and-forget** — a failed delivery or a crash between
"committed" and "delivered" loses the event. For guaranteed delivery use the
**outbox**: domain events are first written to a transactional store, then a relay
publishes them to subscribers with retries (**at-least-once**). Requires
`eventsPlugin`.

```ts
import { webhooksPlugin, webhookOutboxPlugin, webhookOutboxDispatch, WEBHOOKS } from '@basaltkit/webhooks'
import { eventsPlugin, OUTBOX } from '@basaltkit/events'

createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store }),               // no `events:` here — the outbox captures them
    webhookOutboxPlugin({
      events: ['invoice.*', 'user.created'], // patterns to capture (default '**')
      // store: new MyDurableOutboxStore(),  // durable in production (default in-memory)
      intervalMs: 5000,                      // relay poll; 0 = flush manually via OUTBOX
      batchSize: 50,                         // entries per flush
      maxAttempts: 10,                       // then the entry is left dead
    }),
  ],
})
```

`webhookOutboxDispatch` treats an entry as delivered only when **every**
subscribed endpoint accepted it; one failure throws, so the whole entry is
retried against all of them. Subscribers must therefore be **idempotent** — the
payload carries the event name and data for dedup. Resolve the `OUTBOX` token to
relay yourself, e.g. from a queue worker instead of the timer:

```ts
await container.get(OUTBOX).flush(webhookOutboxDispatch(container.get(WEBHOOKS)))
```

Back the outbox with a durable `OutboxStore` (your DB) so nothing is lost across
restarts — the whole point of the pattern. See [Persistence](/guide/persistence).

### Dead entries and flush failures

Two different failures, handled in two different places:

- A **per-entry dispatch failure** increments the entry's `attempts` and records
  `lastError`, then backs off (exponential from 1 s, capped at 60 s, tracked
  per relay process). After `maxAttempts` (default 10) the entry is **dead**:
  it stays in the store with its `lastError` and is never flushed again.
  `Outbox`'s `onDead` callback fires once — by default it writes to
  `console.error`, because a silently dropped integration event is the worst
  possible outcome.
- A **flush-level failure** (the store's `pending()` itself throws) is not an
  entry problem at all. `outboxPlugin`'s `onFlushError` exists for it.

::: warning `webhookOutboxPlugin` doesn't expose `onDead` / `onFlushError`
Its options are exactly `store`, `events`, `intervalMs`, `batchSize` and
`maxAttempts` — it forwards only `maxAttempts` to the `Outbox` it builds, so
dead entries go to `console.error` and a store-level flush failure surfaces as
an unhandled rejection rather than a callback. When you need to page on a dead
event, wire the outbox yourself with `outboxPlugin` from `@basaltkit/events` and
`webhookOutboxDispatch` as its `dispatch`:
:::

```ts
import { eventsPlugin, outboxPlugin } from '@basaltkit/events'
import {
  WebhookDeliverer,
  WebhookManager,
  webhookOutboxDispatch,
  webhooksPlugin,
} from '@basaltkit/webhooks'

const deliverer = new WebhookDeliverer({ secret: process.env.WEBHOOK_SECRET })
const webhooks = new WebhookManager(store, deliverer) // `store` is your WebhookStore

createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store, deliverer }), // the WEBHOOKS token gets the same pieces
    outboxPlugin({
      store: outboxStore,
      captureEvents: ['invoice.*', 'user.created'],
      intervalMs: 5000,
      dispatch: webhookOutboxDispatch(webhooks),
      maxAttempts: 10,
      onDead: (entry, error) => pager.page(`webhook outbox dead: ${entry.event}`, error),
      onFlushError: (error) => logger.error({ error }, 'outbox flush failed'),
    }),
  ],
})
```

Register **one** of the two — both claim the `OUTBOX` token.

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
need to sign manually. `verifySignature` returns `false` — never throws — for a
malformed header, a missing `v1`, a timestamp outside the tolerance, or a
mismatched digest, so a receiver can treat it as a single boolean.

## Delivery semantics

- Transient failures (`5xx`, network errors, timeouts) retry with exponential
  backoff — `500ms`, `1s`, `2s`, … up to `maxRetries` (default `3`, so four
  attempts in total).
- Client errors (`4xx`) are **not** retried — a wrong URL or auth won't fix
  itself on retry. The result carries `error: 'HTTP 404'`.
- Redirects are **refused, not followed**: a `3xx` ends the delivery with
  `error: 'redirect refused'`. Following one would let a compliant public URL
  bounce the request to an internal address.
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

### The SSRF guard

Endpoint URLs are supplied by customers, so every delivery URL is treated as
hostile input. Before the first attempt the deliverer resolves the hostname
**once** and refuses the delivery if the scheme isn't `http:`/`https:`, or if
*any* resolved address is loopback, private (`10/8`, `172.16/12`, `192.168/16`),
link-local (including the `169.254.169.254` cloud-metadata address), CGNAT,
IPv6 ULA, or otherwise reserved.

The socket is then **pinned** to the address that was validated, so a hostile
authoritative DNS can't return a public IP to the check and an internal IP at
connect time (DNS rebinding). The `Host` header and TLS SNI still carry the
original hostname, so vhosts and certificate validation are unaffected.

A blocked URL is a permanent configuration error, not a transient one: the
result is `{ ok: false, attempts: 0, error: 'Refusing to deliver webhook to …' }`
and nothing is retried.

```ts
// Self-hosted setup that must deliver to an internal host:
webhooksPlugin({ secret, ssrf: { allowPrivateHosts: true } })

// HTTPS only (reject http:// endpoints at registration-time delivery):
webhooksPlugin({ secret, ssrf: { allowedSchemes: ['https:'] } })

// Turn the guard off entirely — don't, unless every URL is yours:
webhooksPlugin({ secret, ssrf: false })
```

`allowPrivateHosts: true` skips validation **and** pinning, so the operator's
own resolver is honoured at connect time. `assertDeliverableUrl(url)` is
exported if you want to reject a bad URL at registration time — with a clear
error to the customer — instead of at first delivery.

## Exposing endpoint management over HTTP

The package ships **no HTTP routes**: who may manage a tenant's endpoints is an
app decision, and it is a privileged one (an endpoint is an outbound data
export). Build them on the neutral `route()` so they serve identically on
Fastify, Express and Hono:

```ts
import { route } from '@basaltkit/http'
import { ctx, type Container } from '@basaltkit/core'
import { WEBHOOKS } from '@basaltkit/webhooks'
import { z } from 'zod'

const hooks = () => (ctx().container as Container).get(WEBHOOKS)

export const webhookRoutes = () => [
  route({
    method: 'GET',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    async handler() { return { data: await hooks().list() } },
  }),
  route({
    method: 'POST',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    body: z.object({ url: z.string().url(), events: z.array(z.string()).min(1) }),
    async handler({ body, reply }) {
      // tenantId is forced from ctx() — never read it from the body
      return reply.code(201).send(await hooks().register(body))
    },
  }),
]
```

`meta.teamRole` needs [`teamsPlugin`](/guide/teams); `meta.auth` needs
`authPlugin`. Declaring either without its plugin refuses to boot with
`UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) rather than serving the
route unguarded — see the [adapters guide](/guide/adapters).

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
  // when tenantId is given, remove ONLY if that tenant owns the endpoint
  async remove(id: string, tenantId?: string): Promise<void> { /* … */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
}

webhooksPlugin({ store: new MyWebhookStore(), secret: process.env.WEBHOOK_SECRET })
```

Two rules the built-in store follows and yours must too: `forEvent` returns
endpoints whose `tenantId` matches **or is undefined** (global endpoints get
everything), and it skips `active: false`. `remove(id, tenantId)` must be a
silent no-op when the endpoint belongs to someone else — that is what makes the
anti-widening scope safe.

## Options reference

### `webhooksPlugin(options)`

Everything except `store`, `deliverer` and `events` is forwarded to the
`WebhookDeliverer` it constructs (and ignored if you pass your own `deliverer`).

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `WebhookStore` | `MemoryWebhookStore` | Where subscriptions live — swap for `webhooks-sqlite`/`webhooks-prisma`, or endpoints vanish on restart |
| `deliverer` | `WebhookDeliverer` | built from these options | Bring your own (shared with an outbox relay, or a test double) |
| `events` | `string[]` | `[]` (off) | Domain-event patterns to auto-dispatch. Non-empty makes the plugin depend on `basalt:events` |
| `secret` | `string` | — | Default HMAC signing secret. Without it (and without a per-endpoint `secret`) deliveries are **unsigned** |
| `maxRetries` | `number` | `3` | Retries **after** the first attempt; only `5xx`/network/timeout are retried |
| `backoffMs` | `number` | `500` | Base wait, doubled per attempt (500 ms, 1 s, 2 s, …) |
| `timeoutMs` | `number` | `10_000` | Per-attempt timeout; an abort counts as a transient failure |
| `ssrf` | `SsrfGuardOptions \| false` | on | The delivery-URL guard (below). `false` disables it entirely |
| `fetchImpl` | `typeof fetch` | built-in pinned transport | Injected HTTP client; it receives the validated address on the init object under the exported `PINNED_ADDRESS` symbol |
| `sleep` | `(ms) => Promise<void>` | `setTimeout` | Injectable backoff sleep (tests) |
| `now` | `() => number` | `Date.now()/1000` | Injectable clock in **seconds**, used for the signature timestamp |

### `SsrfGuardOptions` (the `ssrf` option)

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `allowPrivateHosts` | `boolean` | `false` | Trusted self-hosted delivery to internal hosts. Skips validation **and** address pinning |
| `allowedSchemes` | `string[]` | `['https:', 'http:']` | Permitted URL schemes — narrow to `['https:']` to refuse plaintext endpoints |
| `lookup` | `(host) => Promise<{ address, family? }[]>` | `dns.lookup(host, { all: true })` | Injected resolver (tests) |

### `webhookOutboxPlugin(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `OutboxStore` | `MemoryOutboxStore` | Durable outbox — in-memory defeats the pattern's whole purpose |
| `events` | `string[]` | `['**']` (all) | Domain-event patterns captured into the outbox |
| `intervalMs` | `number` | `5000` | Relay poll interval. `0` disables the timer — relay manually through `OUTBOX` |
| `batchSize` | `number` | `50` | Entries delivered per flush |
| `maxAttempts` | `number` | `10` | Attempts before an entry is left dead (never flushed again) |

No `onDead` / `onFlushError` here — use `outboxPlugin` from `@basaltkit/events`
when you need them, as shown above. The plugin depends on both `basalt:webhooks`
and `basalt:events`, and drains the outbox once on shutdown (best-effort).

### Signing & SSRF helpers

| Export | Signature | Purpose |
| --- | --- | --- |
| `signPayload` | `(body, secret, timestampSeconds) => string` | Builds `t=…,v1=…` — sign a payload by hand |
| `verifySignature` | `(header, body, secret, toleranceSeconds = 300, nowSeconds?) => boolean` | Constant-time verify in a receiver; never throws |
| `assertDeliverableUrl` | `(url, options?) => Promise<void>` | Reject an SSRF-unsafe URL at registration time; throws `WebhookUrlBlockedError` |
| `resolveAndValidate` | `(url, options?) => Promise<ValidatedTarget>` | The same check, returning the resolved addresses and the one to pin |
| `isPrivateIp` | `(ip) => boolean` | The range predicate itself; anything that isn't a public IP literal is `true` |
| `matchesEvent` | `(patterns, event) => boolean` | The pattern matcher, for a custom store's `forEvent` |
| `webhookOutboxDispatch` | `(webhooks) => OutboxDispatch` | Adapts a `WebhookManager` into an outbox dispatch; throws if any endpoint fails |

## Failure modes & troubleshooting

Most delivery problems are **not exceptions** — they come back on the
`DeliveryResult`, because one bad endpoint must not fail the others:

| Outcome | `error` | `attempts` | When |
| --- | --- | --- | --- |
| SSRF refusal | `Refusing to deliver webhook to <url>: <reason>` | `0` | Bad scheme, or the host is/resolves to a private, loopback, link-local, CGNAT, ULA or reserved address |
| Client error | `HTTP 4xx` | `1` | The receiver rejected it — never retried |
| Redirect | `redirect refused` | `1` | The endpoint answered `3xx`; following it would defeat the SSRF check |
| Transient | last network/timeout message | `maxRetries + 1` | `5xx`, connection error or per-attempt timeout, retried with backoff, still failing |

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `WebhookUrlBlockedError` | — (`name` only) | — | Thrown by `assertDeliverableUrl` / `resolveAndValidate`; inside `deliver()` it is caught and turned into the failed result above |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `container.get(WEBHOOKS)` without `webhooksPlugin` registered |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | Your own endpoint-management routes declare `meta.auth` / `meta.teamRole` without the enforcing plugin |

- **Every delivery fails with `attempts: 0` in development** — the SSRF guard is
  refusing `localhost` / `127.0.0.1` / a `.local` name. Use a tunnel with a
  public hostname, or `ssrf: { allowPrivateHosts: true }` in the dev config only.
- **Receivers report a bad signature although the secret matches** — they are
  verifying over a re-serialized body. The HMAC covers the exact bytes; capture
  the raw body before parsing.
- **Endpoints disappear after every deploy** — still on `MemoryWebhookStore`.
  Move to `webhooks-sqlite` or `webhooks-prisma`.
- **Events emitted from a job only reach some endpoints** — there is no tenant
  in `ctx()` outside a request, so only global (tenant-less) endpoints match.
  Call `dispatch(event, data, tenantId)` explicitly.
- **A request handler got slow after adding webhooks** — `dispatch` awaits every
  delivery, retries included (up to `(maxRetries + 1) × timeoutMs` per endpoint).
  Move it to the outbox or a queue job.
- **The outbox stops delivering an event and nothing is logged where you look** —
  it hit `maxAttempts` and is dead; the default `onDead` writes to
  `console.error`. Inspect `lastError` on the entry, or wire `outboxPlugin` with
  your own `onDead`.

## See also

- [Queues & jobs](/guide/queues) — drive delivery from a queue for durable retries.
- [Persistence](/guide/persistence) — durable stores, `prisma:sync`, the outbox store.
- [Teams](/guide/teams) — who may manage a tenant's endpoints.
- [Multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas) — per-tenant endpoints in a real app.
