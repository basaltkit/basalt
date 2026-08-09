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
hub.subscribe(conn.id, 'notes') // subscribe to the channels this client has access to

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
hub.subscribe(conn.id, 'notes')
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

| Option | Type | Default | Description |
|---|---|---|---|
| `backplane` | `RealtimeBackplane` | `MemoryBackplane` | Fan-out across instances. |
| `bridge` | `BridgeRule[]` | `[]` | Hook → channel rules (use `bridgeRule(...)`). |

Registers the `REALTIME` (`Realtime`) and `REALTIME_HUB` (`RealtimeHub`) tokens.

### `class Realtime`

| Method | Description |
|---|---|
| `to(tenantId).channel(name).emit(event, data?)` | Publishes an event on the tenant's channel. |
| `to(tenantId).channel(name).presence()` | Online user ids (local). |
| `to(tenantId).channel(name).count()` | Number of connections (local). |

### `class RealtimeHub`

`register(conn)` · `unregister(connId)` · `subscribe(connId, channel)` · `unsubscribe(connId, channel)` · `publish(tenantId, channel, event, data)` · `presence(tenantId, channel)` · `count(tenantId, channel)` · `start()` · `close()`.

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
