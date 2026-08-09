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

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | Server endpoint (`wss://…` or `https://…/sse`). |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | Connection mechanism. |
| `WebSocketImpl` / `EventSourceImpl` | ctor | globals | Injectable implementation (tests / non-browser). |
| `reconnect` | `false \| { minDelayMs?, maxDelayMs? }` | `{}` | Reconnection with exponential backoff. `false` disables it. |

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
| `subscribe()` / `unsubscribe()` | Manually controls the channel subscription. |

## WebSocket vs SSE

- **WebSocket** (recommended) — bidirectional; the client sends `{ type: 'subscribe' \| 'unsubscribe', channel }` commands and receives `{ channel, event, data }` messages.
- **SSE** — receive-only. Subscriptions are decided by the server (based on the URL/authenticated user). The client listens by event name and routes by channel.

### Server side (WebSocket)

`@basaltkit/realtime` decides subscriptions via `hub.subscribe(...)`. Interpret the client's commands in your WebSocket handler:

```ts
socket.on('message', (raw) => {
  const cmd = JSON.parse(raw)
  if (cmd.type === 'subscribe') hub.subscribe(conn.id, cmd.channel)
  if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
})
```

(Always authorize on the server which channels a client can subscribe to — never trust the client.)

## How it connects to other modules

- **`@basaltkit/realtime`** — the server that pushes the events this client receives. The message format is shared (`{ channel, event, data }`).
