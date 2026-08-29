---
"@basaltkit/realtime": minor
---

A dead socket can no longer blackhole a broadcast or crash the process.

`deliverLocal` iterated subscribers calling `connection.send()` with no isolation: a throwing socket (aborted SSE response, CLOSING WebSocket) aborted the loop — every recipient after the dead one got nothing — and via the Redis backplane the exception escaped into ioredis's `message` emitter, an uncaught exception (fatal). Delivery is now isolated per recipient: a throwing `send` prunes that connection and reports it (new `onDeliveryError` option on the hub and `realtimePlugin`, default `console.error`), while everyone else still receives the message. The Redis backplane also guards `JSON.parse` and validates message shape, dropping malformed payloads instead of throwing into the subscriber emitter.
