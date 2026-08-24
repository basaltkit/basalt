---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
'@basaltkit/express': minor
'@basaltkit/hono': minor
---

Add typed Server-Sent Events, adapter-agnostic. A handler returns
`sse(async (stream) => { stream.send(event); … })`; the core encodes the
`text/event-stream` frames and each adapter renders it against its transport
(a Node response on Fastify/Express, a `ReadableStream` on Hono). `stream.send`
(object → JSON, string → data), `close()`, `closed` and `onClose()` (client
disconnect) work identically everywhere. Exposes `sse`, `isSseResponse`,
`encodeSseEvent`, `driveSse`, `SSE_HEADERS`.
