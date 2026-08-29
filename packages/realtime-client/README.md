<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/realtime-client

A **browser** client for [`@basaltkit/realtime`](https://www.npmjs.com/package/@basaltkit/realtime): subscribes to channels, receives real-time events over **WebSocket** or **SSE**, and reconnects on its own. **Zero dependencies** — uses the browser's native `WebSocket`/`EventSource`.

## What this module solves

On the server side, `@basaltkit/realtime` pushes events to per-tenant channels. This package is the other half: what runs in the **browser** (or any runtime with `WebSocket`) to listen for those events and update the UI live — with automatic reconnection and transparent re-subscription.

## Installation

```bash
pnpm add @basaltkit/realtime-client
```

No dependencies. In environments without a global `WebSocket`/`EventSource` (old Node, tests), inject the implementation.

## Get started in 5 minutes

```ts
import { createRealtimeClient } from '@basaltkit/realtime-client'

const client = createRealtimeClient({ url: 'wss://api.example.com/realtime' })

client.channel('notes').on('created', (note) => {
  // update the UI with the new note
})
client.channel('notes').on('deleted', ({ id }) => {
  // remove it from the UI
})

client.on('open', () => console.log('connected'))
client.on('close', () => console.log('disconnected (reconnecting…)'))

client.connect()
```

Registering a handler with `channel(name).on(event, ...)` **automatically subscribes** to the channel. When the connection opens (or reopens), the client re-subscribes to all active channels.

## API

### `createRealtimeClient(options)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `url` | `string` | — (required) | Server endpoint (`wss://…` or `https://…/sse`). |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | Connection mechanism. WebSocket is bidirectional and can send subscribe/unsubscribe; SSE is receive-only. |
| `WebSocketImpl` | `new (url: string) => WebSocketLike` | `globalThis.WebSocket` | Injectable constructor for tests or non-browser runtimes. |
| `EventSourceImpl` | `new (url: string) => EventSourceLike` | `globalThis.EventSource` | Same, for `transport: 'sse'`. |
| `reconnect` | `false \| { minDelayMs?: number; maxDelayMs?: number }` | `{ minDelayMs: 500, maxDelayMs: 10_000 }` | Auto-reconnect with exponential backoff and jitter (each delay is multiplied by a random factor in `[0.5, 1)` so a server restart doesn't stampede every client at once). `false` disables reconnection entirely. |

Reconnection only happens on a close the client did not initiate — `close()` sets a flag that
suppresses it and clears any pending timer. A successful open resets the attempt counter.

### Errors

This package exports no error classes and never throws from a handler path. Two failure
behaviours to know:

| Situation | Behaviour |
|---|---|
| No `WebSocket` / `EventSource` available and none injected | `createRealtimeClient` throws a plain `Error` (`'No WebSocket implementation; pass WebSocketImpl.'` / `'No EventSource implementation; pass EventSourceImpl.'`) — synchronously, at construction. |
| A malformed frame arrives, or the socket emits an error | Routed to the `'error'` lifecycle listeners as the payload. Parse failures never throw into the socket callback, so one bad frame can't tear the connection down. |

Returns a `RealtimeClient`:

| Member | Description |
|---|---|
| `connect()` | Opens the connection. |
| `close()` | Closes it (and disables reconnection). |
| `channel(name)` | Returns a `Channel`. |
| `on('open' \| 'close' \| 'error', handler)` | Lifecycle events. Returns a function to remove it. |
| `connected` | `boolean` — current state. |

### `Channel`

| Method | Description |
|---|---|
| `on(event, handler)` | Listens for an event (subscribes to the channel). Returns a function to remove it. |
| `off(event, handler?)` | Removes a handler (or all handlers for the event). |
| `subscribe()` / `unsubscribe()` | Manually controls the channel subscription. `unsubscribe()` also drops every handler registered for that channel. |

Subscriptions are tracked client-side, so they survive a reconnect: on every `open` the client
re-sends `{ type: 'subscribe', channel }` for each tracked channel. A `subscribe()` issued while
disconnected is remembered and sent when the connection opens.

### Transports (advanced)

`WebSocketTransport` and `SseTransport` are exported along with the `Transport`,
`TransportHandlers`, `RealtimeMessage`, `ClientCommand`, `WebSocketLike`, `WebSocketCtor`,
`EventSourceLike` and `EventSourceCtor` types — implement `Transport` to sit the client on
another mechanism (`connect(handlers)`, `send(command)`, `close()`, optional `track(event)`).
`track` is how SSE learns which event names to `addEventListener` for; WebSocket ignores it.

## WebSocket vs SSE

- **WebSocket** (recommended) — bidirectional; the client sends `{ type: 'subscribe' \| 'unsubscribe', channel }` commands and receives `{ channel, event, data }` messages.
- **SSE** — receive-only. Subscriptions are decided by the server (based on the URL/authenticated user). The client listens by event name and routes by channel.

### Server side (WebSocket)

`@basaltkit/realtime` decides subscriptions via `hub.subscribe(...)`. Interpret the client's commands in your WebSocket handler:

```ts
socket.on('message', async (raw) => {
  const cmd = JSON.parse(raw)
  if (cmd.type === 'subscribe') {
    // subscribe() resolves false when the server's `authorize` gate or a cap refused it
    if (!(await hub.subscribe(conn.id, cmd.channel))) socket.close()
  }
  if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
})
```

Channel names in these commands come straight from the client, so authorize them on the server:
pass `realtimePlugin({ authorize })` and honour the boolean `hub.subscribe()` returns. Never
trust the client.

## Hooks & events

The client's own event surface is the three lifecycle events, plus per-channel message handlers.
There are no configurable callbacks beyond these.

| Event | `on(...)` | Fires when |
|---|---|---|
| `'open'` | `client.on('open', h)` | The transport connected. Every tracked channel is re-subscribed **before** this fires, so a handler here sees a fully restored session. |
| `'close'` | `client.on('close', h)` | The transport closed. A reconnect is scheduled unless you called `close()` or set `reconnect: false`. |
| `'error'` | `client.on('error', h)` | The socket errored, or a frame failed to parse. The payload is the underlying error. On SSE an error also triggers `'close'` (and therefore a reconnect). |
| channel message | `client.channel(n).on(event, h)` | The server pushed `{ channel, event, data }`; the handler receives `data`. |

Every `on(...)` returns its own unsubscribe function.

## How it connects to other modules

- **`@basaltkit/realtime`** — the server that pushes the events this client receives. The message format is shared (`{ channel, event, data }`).
