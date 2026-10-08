---
"@basaltkit/http": minor
"@basaltkit/fastify": minor
"@basaltkit/express": minor
"@basaltkit/hono": minor
---

Request disposers (BK-077). A `RequestEnricher` may now return a `RequestDisposer` — cleanup for the end of its request, such as releasing a leased database client. Every adapter (Fastify, Express, Hono) runs it exactly once when the response has really ended: after a buffered reply, after a `stream()` download or an `sse()` stream finished, after an error response, when a later enricher or guard rejected the request, or when the client went away. Disposers run last-registered first; a failing one is reported as `REQUEST_DISPOSER_FAILED` and never changes the response. Routes without a disposer pay nothing (listeners are attached lazily).

New exports from `@basaltkit/http`: `RequestDisposer`, `RequestDisposers`, and `RoutePipeline.onDispose`. `runRoute` called without `onDispose` (custom adapters, `@basaltkit/mcp`) runs the disposers itself when it returns or throws. Additive: enrichers returning nothing behave exactly as before.
