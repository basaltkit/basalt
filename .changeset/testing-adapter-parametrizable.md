---
"@basaltkit/testing": minor
---

`createTestApp` is now adapter-parametrizable: pass `adapter: 'fastify' | 'express' | 'hono'` and the same suite drives requests through any HTTP adapter.

- **Default unchanged:** `'fastify'` keeps the exact previous behavior — in-process `inject()`, `LightMyRequestResponse` responses, no socket, and no adapter resolution unless a request is actually made (mailer/queue-only test apps still boot without any HTTP plugin).
- **`adapter: 'express'`** listens on an ephemeral `127.0.0.1` port and dispatches via `fetch` (Express has no in-process inject); the socket closes on `shutdown()`. **`adapter: 'hono'`** dispatches in-process via `hono.fetch(new Request(…))`.
- All drivers return the new neutral `TestResponse` shape (`statusCode`, `headers`, `body`, sync `json()`), which the Fastify inject response already satisfies — existing suites read responses unchanged. Pass the matching adapter plugin (`expressPlugin`/`honoPlugin`) in `plugins` yourself, exactly as with `fastifyPlugin` today.
- `@basaltkit/express` and `@basaltkit/hono` are **optional peerDependencies**, resolved lazily only when their adapter is requested — a fastify-only install pulls nothing new; a missing peer fails with an actionable error.
- New exports: `TestAdapterName`, `TestResponse`, `CreateTestAppOptions`. Impersonation (`actingAs`/`asTenant`) works identically on every adapter — it rides the framework-neutral `http:enrichers` bucket.
- New cross-adapter conformance suite exercises the neutral HTTP contract (routing/validation/guards/enrichers/error mapping) identically on Fastify, Express and Hono.
