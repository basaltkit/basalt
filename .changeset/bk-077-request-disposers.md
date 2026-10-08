---
"@basaltkit/http": minor
"@basaltkit/fastify": minor
"@basaltkit/express": minor
"@basaltkit/hono": minor
---

Request disposers (BK-077). A `RequestEnricher` may now return a `RequestDisposer` — cleanup for the end of its request, such as releasing a leased database client. Every adapter (Fastify, Express, Hono) runs it exactly once when the response has really ended: after a buffered reply, after a `stream()` download or an `sse()` stream finished, after an error response, when a later enricher or guard rejected the request, or when the client went away. A disposer never runs while the handler is still running: on a client abort mid-handler it waits until `runRoute` has settled, so the handler keeps a live resource (identical on all three adapters). A disposer registered after that point — even the request's first one, e.g. from a timer the handler left behind or a hook on the finished request context — runs at once; one first registered while a `stream()`/`sse()` body is still open waits for its last byte or abort (identical on all three adapters). Disposers run last-registered first; a failing one is reported as `REQUEST_DISPOSER_FAILED` and never changes the response. Routes without a disposer pay nothing (listeners are attached lazily).

The same sink is reachable as `ctx().onDispose(disposer)` for cleanup taken outside an enricher's return value (a hook listener, a handler). `runRoute` sets it on the request context only — non-enumerable, so a context copied with a spread (`tenancy.run()`) does not inherit it — and its presence tells a plugin that the running pipeline honours disposers (`@basaltkit/prisma` leases only then).

New exports from `@basaltkit/http`: `RequestDisposer`, `RequestDisposers`, `RoutePipeline.onDispose` and the `RequestContext.onDispose` augmentation. `runRoute` called without `onDispose` (custom adapters, `@basaltkit/mcp`) runs the disposers itself when it returns or throws. Additive: enrichers returning nothing behave exactly as before.
