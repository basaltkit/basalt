<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/realtime

Real-time communication for Basalt: **server-to-client push** over WebSocket or SSE, with **per-tenant channels**, **presence** (who's online), and an **event bridge** that connects your app's domain hooks directly to connected clients. You need this module when you want live updates — notifications, feeds, dashboards, collaboration — without the client polling.

## What this module solves

In a typical application the client keeps asking ("anything new?") repeatedly. With realtime, it's the **server that notifies** the client the instant something happens. This module gives you that in a way that is:

- **Framework-neutral** — the core (hub, channels, presence) knows nothing about sockets; the transports (WebSocket/SSE) are thin and connect to your adapter (Fastify/Express/Hono).
- **Multi-tenant** — channels are isolated per tenant: `to('acme').channel('notes')` never delivers to another tenant's clients.
- **Multi-instance** — with the Redis *backplane*, an `emit` on one instance reaches clients connected to **any** instance.
- **Testable without a server** — the core is tested with fake connections; you don't need to open sockets.

## Installation

```bash
pnpm add @basaltkit/realtime
```

Depends only on `@basaltkit/core`. For multi-instance you need a Redis (the client is injected — typically `ioredis`).

## Get started in 5 minutes

### 1. Register the plugin

```ts
import { createApp } from '@basaltkit/core'
import { realtimePlugin, REALTIME } from '@basaltkit/realtime'

const app = await createApp({
  plugins: [realtimePlugin()],
}).boot()
```

### 2. Connect a client (transport)

The core talks to **connections** (`Connection`). You build one from your adapter's socket/response and register it in the hub. WebSocket example:

```ts
import { REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'

// in your adapter's WebSocket upgrade handler, with the user already authenticated:
const hub = app.container.get(REALTIME_HUB)
const conn = websocketConnection({ tenantId: tenant.id, userId: user.id }, socket)
hub.register(conn)
// subscribe() is async and returns false when refused (authorize gate, caps, bad name)
if (!(await hub.subscribe(conn.id, 'notes'))) socket.close()

socket.on('close', () => hub.unregister(conn.id))
```

It's the same with **SSE**, but you provide how to write to the response (framework-neutral):

```ts
import { sseConnection } from '@basaltkit/realtime'

reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
const conn = sseConnection(
  { tenantId: tenant.id, userId: user.id },
  { write: (chunk) => reply.raw.write(chunk), end: () => reply.raw.end() },
)
hub.register(conn)
if (!(await hub.subscribe(conn.id, 'notes'))) reply.raw.end()
reply.raw.on('close', () => hub.unregister(conn.id))
```

### 3. Emit from the server

```ts
const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Hello' })
// every client of tenant 'acme' subscribed to 'notes' receives the event
```

## Event bridge (hooks → push)

Instead of calling `emit` by hand, connect a domain hook to a channel. Whenever the hook fires, the payload is pushed to clients — without touching the code that emits the event:

```ts
import { realtimePlugin, bridgeRule } from '@basaltkit/realtime'

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',            // a hook declared in your app
      tenant: (p) => p.tenantId,        // which tenant to deliver to (undefined → skips)
      channel: 'notes',                 // or a function (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,              // optional; defaults to sending the whole payload
    }),
  ],
})
```

`bridgeRule` validates the types against the hook's payload, so `p` has the right type.

`BridgeRule` fields:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `hook` | `keyof BasaltHooks & string` | — (required) | The core hook to listen to. |
| `tenant` | `(payload) => string \| undefined` | — (required) | Which tenant receives the push. Return `undefined` to skip this event — that is the intended way to filter. |
| `channel` | `string \| ((payload) => string)` | — (required) | Target channel; a function lets you shard per record (`` (p) => `notes:${p.folderId}` ``). |
| `event` | `string` | — (required) | Event name the client listens for. |
| `data` | `(payload) => unknown` | the whole hook payload | What to send. **Set this** when the hook payload contains fields the client shouldn't see. |

## Authorizing subscriptions

By default the hub accepts any channel name a connection asks for, within its tenant. That is
fine when every channel in a tenant is readable by every member of it — and a data leak the
moment it isn't (a user's private channel, an admin feed). Pass `authorize`:

```ts
realtimePlugin({
  authorize: (connection, channel) => {
    if (channel.startsWith('user:')) return channel === `user:${connection.userId}`
    if (channel.startsWith('admin:')) return isAdmin(connection.userId)
    return true
  },
})
```

The gate runs server-side on every `hub.subscribe()`, before the connection is attached, and may
be async. A refusal makes `subscribe()` resolve `false` — your adapter decides whether to close
the socket or just ignore the request. Never trust a channel name that came from the client
without this.

The two caps (`maxSubscriptionsPerConnection`, `maxChannelLength`) are enforced in the same
place, so a client that loops `subscribe` cannot grow the hub's maps without bound.

## Presence

```ts
realtime.to('acme').channel('notes').presence() // → ['user-1', 'user-7']  (unique online ids)
realtime.to('acme').channel('notes').count()    // → number of connections
```

Presence counts connections **on this instance**. In multi-instance setups, each node knows only its local clients — for an aggregated global view, sum across instances (or publish join/leave over the backplane; a future enhancement).

## Multi-instance with Redis

Pass a `RedisBackplane` so an `emit` on one instance reaches clients on all of them. Provide **two** Redis clients (a client in subscribe mode can't publish):

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@basaltkit/realtime'

realtimePlugin({
  backplane: new RedisBackplane({ publisher: new Redis(url), subscriber: new Redis(url) }),
})
```

`emit` does a `PUBLISH`; Redis delivers to **all** subscribed instances (including the origin one), and each hub delivers to its local connections — the same path serves one node or many.

## API reference

### `realtimePlugin(options?)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `backplane` | `RealtimeBackplane` | `new MemoryBackplane()` | Fan-out across instances. The memory backplane loops straight back and only serves one process. |
| `bridge` | `BridgeRule[]` | `[]` | Hook → channel rules (build them with `bridgeRule(...)`). |
| `authorize` | `(connection: Connection, channel: string) => boolean \| Promise<boolean>` | allow all | **Server-side subscription gate.** Set this whenever a channel carries anything not readable by every member of the tenant — without it, any authenticated connection can subscribe to any channel name inside its tenant. Return `false` to refuse. |
| `maxSubscriptionsPerConnection` | `number` | `1000` | Cap on distinct channels one connection may hold. A DoS bound: without it a client can subscribe in a loop and grow the hub's maps unbounded. |
| `maxChannelLength` | `number` | `256` | Cap on a channel name's length. Same reason; empty names are refused too. |
| `onBridgeError` | `(error: unknown, info: { hook: string; channel: string; event: string }) => void` | `console.error` naming the hook, channel and event | A bridged broadcast failed — see [Failure hooks](#failure-hooks). |
| `onDeliveryError` | `(error: unknown, info: { connectionId: string; tenantId: string; channel: string; event: string }) => void` | `console.error` naming the connection, tenant, channel and event | A single client's `send` threw — see [Failure hooks](#failure-hooks). |

Registers the `REALTIME` (`Realtime`) and `REALTIME_HUB` (`RealtimeHub`) tokens, `start()`s the
hub on boot (subscribing the backplane), wires the bridge rules to the core hook bus, and
`close()`s the hub on shutdown.

`authorize`, `maxSubscriptionsPerConnection`, `maxChannelLength` and `onDeliveryError` are
forwarded to the hub — they are also `RealtimeHubOptions`, so a hand-built `new RealtimeHub(backplane, options)`
takes exactly the same four.

### Failure hooks

Realtime has no error classes. Both failure paths are **callbacks with a non-silent default**,
because a realtime push is cosmetic fan-out and must never fail the domain write that triggered
it — but it must not vanish either.

| Hook | Fires when | Default | What happens regardless |
|---|---|---|---|
| `onBridgeError` | A `bridge` rule's broadcast rejected — typically the backplane is down (Redis unreachable). | `console.error` with hook → channel, event | The hook handler is fire-and-forget: the failure is caught, so the domain write that emitted the hook still succeeds. Clients simply miss that push. |
| `onDeliveryError` | One connection's `send()` **threw** during local delivery — a dead or closing socket. | `console.error` with the connection, tenant, channel and event | That connection is **pruned** (`unregister`), and every remaining subscriber still receives the message. One dead socket never stops the fan-out, and never throws into the backplane's message emitter (fatal on a real ioredis subscriber). |

Point both at your logger in production — a permanently failing bridge means clients are
silently stale, and a spike in delivery errors means sockets are dying faster than they are
being unregistered.

Separately, the `RedisBackplane` drops malformed or unparseable messages arriving on the shared
pub/sub channel and logs them with `console.error`; it never throws into ioredis's `'message'`
emitter, where an escaped exception would be an `uncaughtException`.

### Errors

| Error | Code | When |
|---|---|---|
| — | — | This package exports no error classes. Refusals are reported as return values (`hub.subscribe(...)` resolves `false`) and faults as callbacks (`onBridgeError`, `onDeliveryError`). |

### `class Realtime`

| Method | Description |
|---|---|
| `to(tenantId).channel(name).emit(event, data?)` | Publishes an event on the tenant's channel. |
| `to(tenantId).channel(name).presence()` | Online user ids (local). |
| `to(tenantId).channel(name).count()` | Number of connections (local). |

### `class RealtimeHub`

`new RealtimeHub(backplane?, options?: RealtimeHubOptions)`.

| Method | Signature | Description |
|---|---|---|
| `start` | `() => Promise<void>` | Subscribes the backplane so cross-instance messages reach local connections. The plugin calls it at boot. |
| `register` | `(connection: Connection) => void` | Tracks a live connection. |
| `unregister` | `(connectionId: string) => void` | Drops the connection and all its subscriptions/presence. |
| `subscribe` | `(connectionId: string, channel: string) => Promise<boolean>` | Attaches a connection to a channel. **Returns whether it was accepted** — `false` when the connection is unknown, the name is empty or longer than `maxChannelLength`, `maxSubscriptionsPerConnection` is reached, or `authorize` refused. Idempotent (a repeat returns `true`). |
| `unsubscribe` | `(connectionId: string, channel: string) => void` | Detaches from one channel. |
| `publish` | `(tenantId, channel, event, data) => Promise<void>` | Publishes to every subscriber across all instances. |
| `presence` | `(tenantId, channel) => string[]` | Distinct user ids on **this node**. |
| `count` | `(tenantId, channel) => number` | Connection count on **this node**. |
| `close` | `() => Promise<void>` | Closes every connection and the backplane. |

**`subscribe()` is `async` and its `false` is the security signal.** Adapters **must** check it
and refuse or close the client — ignoring the result turns a denied `authorize` into a silent
no-op that looks like a working subscription.

### `interface Connection`

What a transport hands the hub: `id`, `tenantId`, optional `userId`, `send(message)`, `close()`.
The hub never touches a socket directly, which is what keeps the core framework-neutral and
unit-testable with fakes. `userId` is what makes a connection visible in `presence()`.

### Transports

- `websocketConnection(meta, socket)` — from any `ws`-like socket (`send`/`close`).
- `sseConnection(meta, { write, end })` — SSE; you provide how to write/end.
- `sseFrame(message)` — formats a message as an SSE frame.

### Backplanes

- `MemoryBackplane` — single process (default).
- `RedisBackplane({ publisher, subscriber, channel? })` — Redis pub/sub (`channel` default `'basalt:realtime'`).

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`, tokens, and the hook bus the event bridge consumes.
- **`@basaltkit/events`** — emits domain events; the `bridge` turns them into push.
- **`@basaltkit/notifications`** — common pattern: notification persisted **and** pushed live by the same event.
- **`@basaltkit/tenancy` / `@basaltkit/auth`** — where the `tenantId`/`userId` you assign to each connection come from.
