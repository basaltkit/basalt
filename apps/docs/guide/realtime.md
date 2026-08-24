# Realtime

`@basaltkit/realtime` pushes events from the server to connected clients over
WebSocket or SSE, with **per-tenant channels** and **presence**. Its browser
half, [`@basaltkit/realtime-client`](#browser-client), subscribes and reconnects.
Together they turn a domain event into a live UI update, end to end.

[[toc]]

## Setup

```ts
import { createApp } from '@basaltkit/core'
import { realtimePlugin, REALTIME } from '@basaltkit/realtime'

const app = await createApp({
  plugins: [realtimePlugin()],
}).boot()

const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Hi' })
```

`to(tenantId).channel(name).emit(event, data)` delivers to every client of that
tenant subscribed to that channel — and to no one else. Channels are always
scoped by tenant.

## Connecting a client (transport)

The core speaks to **connections**, not sockets. Build a `Connection` from your
adapter's socket/response and register it — the framework-specific part is just
those two lines.

```ts
import { REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'

// in your WebSocket upgrade handler, once the user is authenticated:
const hub = app.container.get(REALTIME_HUB)
const conn = websocketConnection({ tenantId: tenant.id, userId: user.id }, socket)
hub.register(conn)
hub.subscribe(conn.id, 'notes') // authorize + subscribe the channels this user may see

socket.on('message', (raw) => {
  const cmd = JSON.parse(raw) // { type: 'subscribe' | 'unsubscribe', channel }
  if (cmd.type === 'subscribe') hub.subscribe(conn.id, cmd.channel)
  if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
})
socket.on('close', () => hub.unregister(conn.id))
```

::: warning Authorize on the server
Never trust the client's channel choice blindly — check that the authenticated
user may access a channel before calling `hub.subscribe`.
:::

**SSE** is the same, but you supply how to write to the response:

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

## Simple SSE from a route

For plain one-way streaming — progress, logs, a live counter — you don't need the
channels above. Return `sse()` from any route and it streams `text/event-stream`
on **every adapter** (Fastify, Express, Hono):

```ts
import { sse, route } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/progress/:job',
  async handler({ params }) {
    return sse(async (stream) => {
      stream.onClose(() => stopWatching(params.job)) // client disconnected
      for await (const pct of watch(params.job)) {
        stream.send({ event: 'progress', data: { pct } })
        if (pct === 100) break
      }
      stream.close()
    })
  },
})
```

`stream.send(event)` JSON-encodes an object (or sends a string as a bare `data:`);
`event`, `id` and `retry` are optional. On the browser:

```js
const es = new EventSource('/progress/42')
es.addEventListener('progress', (e) => console.log(JSON.parse(e.data).pct))
```

Reach for the channel-based realtime package above only when you need pub/sub,
per-tenant fan-out or presence.

## Complete Fastify WebSocket server

Putting it together with `@fastify/websocket` — `realtimePlugin` registers both
`REALTIME` and `REALTIME_HUB` and starts the hub on boot:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { realtimePlugin, REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'
import fastifyWebsocket from '@fastify/websocket'

const app = await createApp({ plugins: [fastifyPlugin(), realtimePlugin()] }).boot()

const fastify = app.container.get(FASTIFY)
const hub = app.container.get(REALTIME_HUB)
await fastify.register(fastifyWebsocket)

fastify.get('/realtime', { websocket: true }, (socket, request) => {
  // authenticate the connection (JWT in query, cookie, header…) → tenant + user
  const { tenantId, userId } = authenticate(request)
  const conn = websocketConnection({ tenantId, userId }, socket)
  hub.register(conn)

  socket.on('message', (raw) => {
    const cmd = JSON.parse(raw.toString()) // { type: 'subscribe' | 'unsubscribe', channel }
    if (cmd.type === 'subscribe' && mayAccess(userId, cmd.channel)) hub.subscribe(conn.id, cmd.channel)
    if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
  })
  socket.on('close', () => hub.unregister(conn.id))
})

await fastify.listen({ port: 3000 })
```

## Events bridge

Wire a domain hook straight to a channel — pushes happen without touching the
emitting code:

```ts
import { realtimePlugin, bridgeRule } from '@basaltkit/realtime'

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',
      tenant: (p) => p.tenantId,
      channel: 'notes',        // or (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,     // default: the whole payload
    }),
  ],
})
```

## Presence

```ts
realtime.to('acme').channel('notes').presence() // → user ids online
realtime.to('acme').channel('notes').count()    // → connection count
```

Presence reflects this instance's connections. Across instances, each node knows
its local clients — sum them for a global view.

## Scaling out (Redis backplane)

By default the backplane is in-memory (one process). For multiple instances,
pass a `RedisBackplane` so an emit on one node reaches clients on every node:

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@basaltkit/realtime'

realtimePlugin({
  backplane: new RedisBackplane({ publisher: new Redis(url), subscriber: new Redis(url) }),
})
```

An emit `PUBLISH`es to Redis; every instance receives it via `SUBSCRIBE`
(including the origin) and delivers to its local connections — one code path for
one node or many. Provide **two** clients: a subscriber connection can't publish.

## Browser client

`@basaltkit/realtime-client` is a zero-dependency client using the browser's
native `WebSocket`/`EventSource`.

```bash
npm add @basaltkit/realtime-client
```

```ts
import { createRealtimeClient } from '@basaltkit/realtime-client'

const client = createRealtimeClient({ url: 'wss://api.example.com/realtime' })

client.channel('notes').on('created', (note) => addToUi(note))
client.channel('notes').on('deleted', ({ id }) => removeFromUi(id))
client.on('close', () => showReconnectingBadge())

client.connect()
```

Registering a handler auto-subscribes the channel; the client re-subscribes
every active channel when the connection (re)opens, and reconnects with
exponential backoff until you call `client.close()`. Pass `transport: 'sse'` for
Server-Sent Events, or `reconnect: false` to disable auto-reconnect.

## End to end

```
note created ─▶ note:created hook ─▶ bridge ─▶ realtime.emit
             ─▶ Redis backplane ─▶ every instance
             ─▶ each hub delivers to local WS/SSE connections
             ─▶ browser client 'created' handler ─▶ UI updates
```

See the [notes SaaS cookbook](/cookbook/notes-saas) for the surrounding app.
