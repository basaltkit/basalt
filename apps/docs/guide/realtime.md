# Realtime

`@basaltkit/realtime` pushes events from the server to connected clients over
WebSocket or SSE, with **per-tenant channels** and **presence**. It is decoupled
from your HTTP framework — the core only ever sees a `Connection` object, so the
same wiring runs on Fastify, Express and Hono — and from your domain code, which
never has to know that anyone is listening. Its browser half,
[`@basaltkit/realtime-client`](#browser-client), subscribes and reconnects.
Reach for it when a change made by one user has to appear on another user's
screen without a poll.

[[toc]]

## Mental model

Six pieces, and only two of them are framework-specific:

| Piece | What it is | Lives |
| --- | --- | --- |
| `Realtime` (token `REALTIME`) | The fluent facade you call: `to(tenant).channel(name).emit()` | your code |
| `RealtimeHub` (token `REALTIME_HUB`) | Registry of connections, subscriptions and presence; delivers to local sockets | one per process |
| `Connection` | `{ id, tenantId, userId?, send(), close() }` — built from your socket/stream by `websocketConnection()` / `realtimeSse()` (`sseStreamConnection()`) / `sseConnection()` | per client |
| `RealtimeBackplane` | Fan-out across processes: `MemoryBackplane` (default) or `RedisBackplane` | process / Redis |
| Bridge rules | Map a core hook to an emit, fire-and-forget | on `app.hooks` |
| `@basaltkit/realtime-client` | Browser client: auto-subscribe, auto-reconnect | browser |

The path is always the same: `emit` **publishes to the backplane**, the backplane
delivers to every hub (**including the one that published**), and each hub writes
to its own local connections. That is one code path whether you run one node or
twenty — the Redis backplane is a swap, not a different mode.

Two consequences worth internalising up front: **presence and connection counts
are per-node** (a hub only knows its own sockets), and **delivery is
fire-and-forget** — nothing in the realtime path can fail a domain write.

## Quickstart

`realtimePlugin` registers both `REALTIME` and `REALTIME_HUB` and starts the hub
on boot. This is a complete, runnable Fastify WebSocket server:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { realtimePlugin, REALTIME, REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'
import fastifyWebsocket from '@fastify/websocket'

const app = await createApp({
  plugins: [
    fastifyPlugin(),
    realtimePlugin({
      // refuse channels this connection may not join — see "Authorizing subscriptions"
      authorize: (connection, channel) => channel === 'notes' || channel === `user:${connection.userId}`,
    }),
  ],
}).boot()

const fastify = app.container.get(FASTIFY)
const hub = app.container.get(REALTIME_HUB)
await fastify.register(fastifyWebsocket)

const ALLOWED_ORIGINS = new Set(['https://app.example.com'])

fastify.get('/realtime', { websocket: true }, (socket, request) => {
  // refuse foreign pages first — see "Cross-site WebSocket hijacking" below
  if (!ALLOWED_ORIGINS.has(String(request.headers.origin))) return socket.close()
  // authenticate the connection (JWT in query, cookie, header…) → tenant + user
  const { tenantId, userId } = authenticate(request)
  const conn = websocketConnection({ tenantId, userId }, socket)
  hub.register(conn)

  socket.on('message', async (raw) => {
    // every frame is client-controlled; a throw here is an unhandled rejection (fatal on Node)
    let cmd: { type?: unknown; channel?: unknown }
    try {
      cmd = JSON.parse(raw.toString())
    } catch {
      return socket.close()
    }
    if (typeof cmd?.channel !== 'string') return socket.close()
    if (cmd.type === 'subscribe') {
      const ok = await hub.subscribe(conn.id, cmd.channel) // false = refused
      if (!ok) socket.send(JSON.stringify({ error: 'subscribe_refused', channel: cmd.channel }))
    } else if (cmd.type === 'unsubscribe') {
      hub.unsubscribe(conn.id, cmd.channel)
    }
  })
  socket.on('close', () => hub.unregister(conn.id))
})

await fastify.listen({ port: 3000 })

// anywhere in your app:
const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Hi' })
```

`to(tenantId).channel(name).emit(event, data)` delivers to every client of that
tenant subscribed to that channel — and to no one else. Channels are always
scoped by tenant: `('acme', 'notes')` and `('globex', 'notes')` are different
channels that can never see each other's traffic.

## Connecting a client (transport)

The core speaks to **connections**, not sockets. Build a `Connection` from your
transport and register it — that is the entire framework-specific surface.

For **SSE**, return `@basaltkit/http`'s `sse()` with `realtimeSse(hub, …)` as the
producer. It runs unchanged on Fastify, Express and Hono: it registers the
connection, joins the channels (each through `authorize`), and unregisters it
when the client goes away.

```ts
import { ctx } from '@basaltkit/core'
import { route, sse } from '@basaltkit/http'
import { realtimeSse, REALTIME_HUB } from '@basaltkit/realtime'

const hub = app.container.get(REALTIME_HUB)

route({
  method: 'GET',
  url: '/live',
  meta: { auth: true },
  handler: () => {
    const { tenant, user } = ctx() as { tenant: { id: string }; user: { id: string } }
    return sse(
      realtimeSse(hub, {
        meta: { tenantId: tenant.id, userId: user.id }, // from the session, never from the client
        channels: ['notes', `user:${user.id}`],
        onOpen: () => { /* optional: send a snapshot */ },
      }),
      { heartbeatMs: 15_000 },
    )
  },
})
```

A channel the hub refuses closes the stream — `EventSource` would reconnect and
be refused again, so check access in the handler first when the client should
get a `403` instead. Backpressure never prunes a slow client: a send that hits a
full buffer is counted, and the stream is closed after `maxBackpressure`
(default 50) consecutive ones.

For **WebSockets**, `websocketConnection(meta, socket)` takes any `ws`-style
socket (`send(string)` + `close()`). The low-level `sseConnection(meta, io)` is
still there as an escape hatch for a response you write yourself
(`{ write(chunk), end() }`, pre-framed with `sseFrame`) — then registering,
subscribing and unregistering on close are yours.

`ConnectionMeta` is `{ tenantId, userId?, id? }` — `id` defaults to a
`randomUUID()`. **`userId` is what feeds presence**: a connection registered
without one is delivered to normally but never appears in `presence()`.

On the wire, a WebSocket connection receives `JSON.stringify({ channel, event, data })`;
an SSE connection receives an `event: <event>` frame whose `data:` is
`{ channel, data }` (CR, LF and NUL are stripped from the event name, so an
event name can never inject extra SSE fields or frames). `@basaltkit/realtime-client` normalises both back to the
same handler signature.

::: warning `unregister` is yours to call
The hub prunes a connection automatically only when its `send` **throws** — and
then also calls its `close()`, so the client sees the drop and reconnects. A
socket that closes cleanly is still registered until you call
`hub.unregister(conn.id)` — always wire it to your transport's close event, or
subscriptions and presence leak for the lifetime of the process.
(`realtimeSse()` does this for you.)
:::

## Authorizing subscriptions

`hub.subscribe(connectionId, channel)` is `async` and returns a **boolean**:
`false` means the subscription was refused. It is refused when the connection id
is unknown — or was unregistered or replaced while `authorize` was still
deciding — when the channel is not a string, when it is empty or longer than `maxChannelLength`
(default 256), when the connection already holds
`maxSubscriptionsPerConnection` channels (default 1000), or when the `authorize`
gate returned `false`. Re-subscribing to a channel you already hold is
idempotent and returns `true`.

```ts
realtimePlugin({
  authorize: async (connection, channel) => {
    if (channel === 'notes') return true                        // tenant-wide
    if (channel === `user:${connection.userId}`) return true     // own private channel
    if (channel === 'admin') return isAdmin(connection.userId)   // async is fine
    return false
  },
  maxSubscriptionsPerConnection: 200,
  maxChannelLength: 128,
})
```

::: danger There is no default gate
Without `authorize`, **any authenticated connection can subscribe to any channel
name inside its tenant** — including another user's private channel, if you
named it after their id. The tenant boundary is enforced for you; everything
finer than that is `authorize`. Set it whenever a channel carries something not
readable by every member of the tenant, and check the boolean that `subscribe`
returns instead of assuming success.
:::

The two caps are DoS bounds, not business rules: they stop one socket from
allocating unbounded subscription entries with generated channel names. Both
the cap and the connection are checked again after `authorize` resolves, so a
burst of concurrent `subscribe` commands can't overshoot the cap, and a socket
that closed mid-gate never leaves a ghost subscription behind. See
[Security](/guide/security) for the request-edge equivalents.

::: danger Cross-site WebSocket hijacking
Browsers attach cookies to a WebSocket handshake from **any** site, and the
same-origin policy does not apply to WebSockets. If your socket authenticates
by cookie, a malicious page can open it as the logged-in user and read every
event pushed to them — `authorize` can't tell the difference, because it *is*
that user. Check the `Origin` header against an allow-list before accepting
the upgrade (as the quickstart does), or authenticate with a token the page has
to send explicitly instead of an ambient cookie.
:::

## Simple SSE from a route

For plain one-way streaming — progress, logs, a live counter — you don't need
channels, presence or a backplane at all. Return `sse()` from any route and it
streams `text/event-stream` on **every adapter** (Fastify, Express, Hono):

```ts
import { sse, route } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/progress/:job',
  async handler({ params }) {
    return sse(
      async (stream) => {
        stream.onClose(() => stopWatching(params.job)) // client disconnected
        for await (const pct of watch(params.job)) {
          if (!stream.send({ event: 'progress', data: { pct } })) break // backpressure
          if (pct === 100) break
        }
        stream.close()
      },
      { heartbeatMs: 15_000, maxDurationMs: 300_000 },
    )
  },
})
```

`stream.send(event)` JSON-encodes an object (or sends a string as a bare
`data:`) and returns **`false`** when the stream is closed or the transport's
write buffer is full — honour it, or a slow client grows your heap. `event`,
`id` and `retry` are optional fields; CR/LF are stripped from `event` and `id`
so a value can't inject extra SSE frames. On the browser:

```js
const es = new EventSource('/progress/42')
es.addEventListener('progress', (e) => console.log(JSON.parse(e.data).pct))
```

Reach for the channel-based package above only when you need pub/sub, per-tenant
fan-out or presence.

## Events bridge

A bridge rule wires a **core hook** (`app.hooks`, the same bus tenancy, auth and
teams emit on) straight to a channel, so pushes happen without touching the
emitting code:

```ts
import { realtimePlugin, bridgeRule } from '@basaltkit/realtime'

// your hook, declared once so the rule is type-checked against its payload
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'note:created': { tenantId: string; note: { id: string; title: string } }
  }
}

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',
      tenant: (p) => p.tenantId,   // return undefined to skip this event
      channel: 'notes',            // or (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,         // default: the whole payload
    }),
  ],
  onBridgeError: (error, { hook, channel, event }) =>
    logger.error({ err: error, hook, channel, event }, 'realtime bridge failed'),
})
```

`bridgeRule()` type-checks one rule against that hook's payload and then erases
the generic, so rules for different hooks live in the same array. Rules are
attached during `boot`.

### Tenant from context (schema- and database-per-tenant apps)

When tenancy isolates by Postgres schema or by database, domain models have no
`tenantId` column, so the payload has nothing to point `tenant` at. **Omit
`tenant`** and the bridge takes the tenant from the active context when the hook
fires: `ctx().tenant.id`, set by `@basaltkit/tenancy`. Hook handlers run inside
the emitter's async context, so a hook emitted while handling a tenant-scoped
request or job delivers to that tenant.

```ts
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'matter:opened': { matter: { id: string; title: string } } // no tenantId
  }
}

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'matter:opened',
      // no `tenant`: delivered to ctx().tenant.id at emit time
      channel: 'matters',
      event: 'opened',
      data: (p) => p.matter,
    }),
  ],
  onBridgeSkipped: ({ hook, channel, event, reason }) =>
    logger.warn({ hook, channel, event, reason }, 'realtime bridge skipped'),
})
```

The two ways an event can be skipped behave differently on purpose:

| Rule | Tenant resolves to | What happens |
| --- | --- | --- |
| `tenant` set | a string | Delivered to that tenant; the context is ignored |
| `tenant` set | `undefined` | Skipped **silently**: it's an explicit opt-out, so it's the way to filter events |
| `tenant` omitted | tenant in context | Delivered to `ctx().tenant.id` |
| `tenant` omitted | no tenant in context | Skipped and reported to **`onBridgeSkipped({ hook, channel, event, reason: 'no-tenant' })`** |

With no tenant in context the hook was emitted outside a tenant-scoped scope:
boot, a cron tick, or a worker that didn't restore the context. Leave
`onBridgeSkipped` unset and the default logs
`[basalt:realtime] bridge skipped (hook "…" -> channel "…", event "…")` via
`console.warn`, **once per rule**, not once per event, so a misconfigured rule
shows up without flooding the logs. For a function `channel`, the reported
channel is evaluated against the payload; if that throws, you get the
placeholder `'<dynamic>'`.

::: warning Don't read a tenant id the payload doesn't carry
`tenant: ({ matter }) => matter?.tenantId` on a model with no `tenantId` column
always returns `undefined`, and that is the *silent* opt-out, so nothing is ever
pushed and nothing is logged. Omit `tenant` instead.
:::

::: tip The bridge can never fail your domain write
The emit is deliberately **fire-and-forget**: the hook handler doesn't await it,
so a dead backplane can't reject into — or slow down — the transaction that
emitted the hook. A realtime push is cosmetic; the write is not. The rejection
is handed to **`onBridgeError(error, { hook, channel, event })`** instead. Leave
it unset and the default logs
`[basalt:realtime] bridge broadcast failed (hook "…" -> channel "…", event "…")`
via `console.error` — never silent, but never routed to your logger either. Set
it in production so the failure lands in the same place as everything else you
alert on.
:::

## Presence

```ts
realtime.to('acme').channel('notes').presence() // → distinct user ids online (this node)
realtime.to('acme').channel('notes').count()    // → connection count (this node)
```

Both are **synchronous and local**. `presence()` returns the distinct `userId`s
of the connections subscribed to that channel *on this process*; connections
registered without a `userId` are invisible to it, and `count()` counts
connections, not users — one user with three tabs is `count() === 3` and one
entry in `presence()`.

Across instances each node knows only its own clients. For a global view, sum
them: expose a small internal endpoint per node and aggregate, or have each node
publish its local presence on a timer. The backplane does not replicate presence
state.

## Scaling out (Redis backplane)

By default the backplane is `MemoryBackplane` — publish loops straight back into
the same process. For multiple instances, pass a `RedisBackplane` so an emit on
one node reaches clients on every node:

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@basaltkit/realtime'

const publisher = new Redis(process.env.REDIS_URL!)
const subscriber = new Redis(process.env.REDIS_URL!)

realtimePlugin({
  backplane: new RedisBackplane({ publisher, subscriber, channel: 'basalt:realtime' }),
})
```

An emit `PUBLISH`es to one Redis channel; every instance receives it via
`SUBSCRIBE` (**including the origin**) and delivers to its local connections.
Provide **two** clients: a connection in subscribe mode can't publish.

The Redis channel is shared by **everything on that Redis using the same
name**, and a message names its tenant only by id. Two apps — or staging and
production — that both keep the default `'basalt:realtime'` deliver into each
other's tenants, and anyone able to `PUBLISH` on that Redis can push an event
to any tenant. Give every deployment its own `channel`, and set `secret` to
sign messages with HMAC-SHA256:

```ts
new RedisBackplane({
  publisher,
  subscriber,
  channel: 'myapp:prod:realtime',
  secret: process.env.REALTIME_BACKPLANE_SECRET!, // [newKey, oldKey] while rotating
})
```

With `secret`, unsigned, tampered or foreign-key messages are dropped and
logged. The first key signs and every key verifies, so rotation is: deploy
`[new, old]` everywhere, then `new` alone. All instances must agree — a node
with a secret and one without drop each other's pushes.

Two robustness properties are built in, because an exception escaping ioredis's
`'message'` emitter is an `uncaughtException` and would kill the process:
unparseable payloads and payloads missing `tenantId`/`channel`/`event` are
**dropped and logged** rather than thrown, and a single dead socket during local
delivery is pruned (and closed) while the remaining recipients still receive the
message. A payload JSON can't encode (a `BigInt`, a cycle) never gets that far:
`emit()` rejects with the `TypeError` on every backplane, before anything is
sent.

::: warning Close your Redis clients yourself
`app.shutdown()` closes every connection and calls the backplane's optional
`close()`. `RedisBackplane` does not implement one, so the two ioredis clients
stay open — quit them in your own shutdown path or the process won't exit.
:::

## Browser client

`@basaltkit/realtime-client` is a zero-dependency client over the browser's
native `WebSocket`/`EventSource`.

```bash
npm add @basaltkit/realtime-client
```

```ts
import { createRealtimeClient } from '@basaltkit/realtime-client'

const client = createRealtimeClient({
  url: 'wss://api.example.com/realtime',
  reconnect: { minDelayMs: 500, maxDelayMs: 10_000 },
})

const off = client.channel('notes').on('created', (note) => addToUi(note))
client.channel('notes').on('deleted', ({ id }) => removeFromUi(id))
client.on('close', () => showReconnectingBadge())
client.on('error', (err) => console.warn('realtime', err))

client.connect()
// later: off()  — drop one handler
// client.channel('notes').unsubscribe()  — leave the channel
// client.close() — stop reconnecting entirely
```

Registering a handler auto-subscribes the channel. On every (re)open the client
re-sends `subscribe` for **all** active channels, so a reconnect restores state
without you tracking it. Reconnect delay is
`min(maxDelayMs, minDelayMs · 2^attempts)` with 50–100 % jitter, reset on a
successful open; `reconnect: false` disables it, and `client.close()` stops it
permanently (a later `connect()` re-enables it).

::: warning SSE is receive-only
With `transport: 'sse'`, `subscribe`/`unsubscribe` commands are **not sent** —
`EventSource` has no upstream channel. The server must derive the connection's
channels from the URL or the authenticated user at connect time, and the client
only uses its channel registry to route incoming frames. Use the default
WebSocket transport whenever clients need to choose their own channels.
:::

In tests or on Node, inject the socket implementations with `WebSocketImpl` /
`EventSourceImpl` — without a global and without an override, `createRealtimeClient`
throws immediately. See [Testing](/guide/testing).

## End to end

```
note created ─▶ note:created hook ─▶ bridge rule ─▶ realtime.emit
             ─▶ backplane (memory or Redis PUBLISH)
             ─▶ every instance's hub ─▶ local WS/SSE connections
             ─▶ browser client 'created' handler ─▶ UI updates
```

## Options reference

`realtimePlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `backplane` | `RealtimeBackplane` | `new MemoryBackplane()` | Cross-process fan-out; pass `RedisBackplane` to run more than one instance |
| `bridge` | `BridgeRule[]` | `[]` | Map core hooks to emits so domain code stays unaware of realtime |
| `authorize` | `(connection, channel) => boolean \| Promise<boolean>` | allow all | Server-side subscription gate — the only thing between a connection and any channel name in its tenant |
| `maxSubscriptionsPerConnection` | `number` | `1000` | DoS bound: channels one connection may hold |
| `maxChannelLength` | `number` | `256` | DoS bound: max channel-name length |
| `onBridgeError` | `(error, { hook, channel, event }) => void` | `console.error` | Where a failed **bridged** broadcast is reported; the failure never reaches the emitting domain code |
| `onBridgeSkipped` | `(info: { hook, channel, event, reason: 'no-tenant' }) => void` | `console.warn`, once per rule | Where a rule **without `tenant`** reports an event skipped because no tenant was in context. Not called when your own `tenant` returns `undefined` |
| `onDeliveryError` | `(error, { connectionId, tenantId, channel, event }) => void` | `console.error` | Where a failed **local write** to one socket is reported; that connection is pruned, the rest still receive the message |

`bridgeRule(rule)`:

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `hook` | `keyof BasaltHooks & string` | — | The core hook to listen on |
| `tenant` | `(payload) => string \| undefined` | tenant in context | Which tenant to deliver to; `undefined` skips the event silently. Omit it to use `ctx().tenant.id` at emit time (schema-/database-per-tenant apps); with no tenant there, the event is skipped and reported to `onBridgeSkipped` |
| `channel` | `string \| (payload) => string` | — | Fixed or payload-derived channel name |
| `event` | `string` | — | Event name the client listens for |
| `data` | `(payload) => unknown` | whole payload | Narrow what leaves the server — the payload is delivered to every subscriber |

`new RedisBackplane(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `publisher` | `RedisRealtimeClient` | — | Client used for `PUBLISH` (must not be in subscribe mode) |
| `subscriber` | `RedisRealtimeClient` | — | Client used for `SUBSCRIBE` |
| `channel` | `string` | `'basalt:realtime'` | Redis channel the instances share; give each app/environment on one Redis its own |
| `secret` | `string \| string[]` | unsigned | HMAC-SHA256 key(s): the first signs, all verify; unsigned or wrongly signed messages are dropped. Empty throws at construction |

`sse(producer, options)` (from `@basaltkit/http`):

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `heartbeatMs` | `number` | off | Comment ping interval — keeps proxies from closing an idle stream and surfaces dead sockets |
| `maxDurationMs` | `number` | off | Hard cap on one stream's lifetime; a backstop against connections that never disconnect |

`realtimeSse(hub, options)` — the producer you pass to `sse()`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `meta` | `ConnectionMeta` | — | `{ tenantId, userId?, id? }` of the connection — take it from the request context, never from the client |
| `channels` | `readonly string[]` | — | Channels to join; each goes through the hub's `authorize`, and one refusal closes the stream |
| `onOpen` | `(connection) => void \| Promise<void>` | — | Runs once every channel is joined (e.g. send a snapshot) |
| `maxBackpressure` | `number` | `50` | Consecutive sends that hit a full buffer before the stream is closed; a send that goes through resets the count |

`createRealtimeClient(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `url` | `string` | — | WebSocket (`wss://…`) or SSE endpoint |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | `'sse'` is receive-only: the client cannot ask for channels |
| `reconnect` | `false \| { minDelayMs?: number; maxDelayMs?: number }` | `{ minDelayMs: 500, maxDelayMs: 10_000 }` | Jittered exponential backoff; `false` for a single attempt |
| `WebSocketImpl` | `WebSocketCtor` | `globalThis.WebSocket` | Inject a socket implementation (Node, tests) |
| `EventSourceImpl` | `EventSourceCtor` | `globalThis.EventSource` | Inject an `EventSource` implementation |

## Failure modes & troubleshooting

`@basaltkit/realtime` deliberately throws **no coded errors at runtime**: a push
is cosmetic, so every failure is reported through a callback and swallowed
rather than propagated. These are the signals to watch:

| Failure | Surfaced as | Default behaviour | When |
| --- | --- | --- | --- |
| Bridged broadcast rejected | `onBridgeError(error, { hook, channel, event })` | `console.error`, event dropped | The backplane is down/unreachable while a bridge rule fires |
| Bridged event had no tenant | `onBridgeSkipped({ hook, channel, event, reason: 'no-tenant' })` | `console.warn` once per rule, event dropped | A rule without `tenant` fired outside a tenant-scoped context (boot, cron, a worker without context) |
| Local write to a socket threw | `onDeliveryError(error, { connectionId, tenantId, channel, event })` | `console.error`, connection **unregistered and closed**, other recipients still served | A socket died between the last write and this one |
| Payload not JSON-serializable | `emit()` / `hub.publish()` rejects with `TypeError` (bridged: `onBridgeError`) | nothing sent, no subscriber touched | `data` holds a `BigInt`, a cycle, or similar |
| Subscription refused | `hub.subscribe()` resolves `false` | nothing — silent unless you check | Unknown connection id (or it closed/was replaced during `authorize`), non-string/empty/over-long channel, per-connection cap hit, or `authorize` returned `false` |
| Malformed backplane payload | `console.error` from the Redis driver | message dropped | Something else `PUBLISH`ed to the same Redis channel, a version mismatch, or — with `secret` — a missing/invalid signature or instances with different keys |
| `UnknownTokenError` (`DI_UNKNOWN_TOKEN`) | thrown at resolve time | boot/request fails | `REALTIME` / `REALTIME_HUB` resolved without `realtimePlugin` registered |
| `Error: No WebSocket implementation; pass WebSocketImpl.` | thrown by `createRealtimeClient` | client construction fails | Running outside a browser with no `WebSocketImpl`/`EventSourceImpl` injected |

- **Clients connect but never receive anything** — the emit's tenant doesn't
  match the connection's `tenantId`, or nobody called `hub.subscribe`. Channels
  are keyed by `(tenantId, channel)`; an emit to `'acme'` is invisible to a
  connection registered with `tenantId: 'Acme'`.
- **`subscribe` silently does nothing** — it returned `false`. Check the
  `authorize` gate first, then the channel-name length and the per-connection
  cap. Always `await` it: it is async, and an unawaited call to it is a
  floating promise.
- **Works on one instance, breaks after scaling to two** — you're still on the
  default `MemoryBackplane`. Pass `RedisBackplane` with **two** clients; a
  single client reused for both publishing and subscribing fails once it enters
  subscribe mode.
- **`presence()` is empty although users are connected** — either the
  connections were registered without a `userId`, or those users are attached to
  a different node. Presence is per-process by design.
- **Connection count only grows** — `hub.unregister(conn.id)` isn't wired to the
  socket's close event. Only a *throwing* `send` prunes a connection
  automatically.
- **The process won't exit on shutdown** — `RedisBackplane` has no `close()`;
  quit the ioredis clients yourself after `app.shutdown()`.

See the [notes SaaS cookbook](/cookbook/notes-saas) for the surrounding app, and
[Observability](/guide/observability) for putting `onBridgeError` /
`onDeliveryError` on your logger instead of the console.
