---
"@basaltkit/realtime": minor
---

BK-079: `realtimeSse(hub, { meta, channels, onOpen?, maxBackpressure? })` is a
producer for `@basaltkit/http`'s `sse()`, so a hub-backed SSE endpoint runs
unchanged on Fastify, Express and Hono (no `reply.raw`). It registers the
connection, joins each channel through `authorize` (a refusal closes the
stream) and unregisters it when the client disconnects.
`sseStreamConnection(meta, stream, { maxBackpressure })` is the underlying
`Connection`: it sends the same wire shape as `sseFrame`, throws only once the
stream is closed (so the hub prunes it), and closes the stream after
`maxBackpressure` (default 50) consecutive sends that hit a full buffer instead
of letting the hub prune a merely slow client. Both are typed against a
structural `SseStreamLike`; the package still has no runtime dependency on
`@basaltkit/http`. `sseConnection` stays as the low-level escape hatch.
