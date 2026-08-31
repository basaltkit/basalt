---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
'@basaltkit/express': minor
'@basaltkit/hono': minor
---

**Failed requests are now reported on every adapter, at every status.**

Whether an error was visible used to depend on which adapter you had mounted —
exactly the difference the neutral pipeline exists to erase:

| | before | now |
| --- | --- | --- |
| `@basaltkit/fastify` | 5xx only, and only from one of its **two** catch sites | every 4xx/5xx, both sites |
| `@basaltkit/express` | **nothing at all** — a 500 left no server trace | every 4xx/5xx |
| `@basaltkit/hono` | **nothing at all** — a 500 left no server trace | every 4xx/5xx |

Client errors were silent everywhere. That is defensible for a 404 from a
scanner, and useless when you are trying to work out why your own request came
back 400 and the terminal is empty.

### The policy

5xx go to `error` **with the error object**, so the stack survives — it is a bug.
4xx go to `warn` as a single line with the code and message; a validation
failure's stack is noise.

It lives in `@basaltkit/http` (`reportHttpError`, `httpErrorReporter`,
`HttpErrorReport`, `HttpErrorReporter`, `HttpLogSink`), so the three adapters
cannot drift apart. Each adapter's suite asserts the same behaviour.

### Overriding it

`fastifyPlugin`, `expressPlugin` and `honoPlugin` all accept `onError`:

```ts
fastifyPlugin({
  routes,
  onError: ({ error, status, code, method, url }) =>
    logger.error({ err: error, status, code, method, url }, 'request failed'),
})
```

Pass `() => {}` to silence them.

### Where the default writes

Fastify uses its own logger, so records stay structured for apps that configured
pino — **and the console for apps that did not**. A server built with
`logger: false` (Fastify's default, and what `create-basalt` scaffolds) installs
a no-op logger, so writing there would have discarded the report and left
"observable by default" true only for apps that least needed it. Express and
Hono use the console.

Note that Fastify's logger and `@basaltkit/logger` are separate systems: a level
set on `loggerPlugin` does not affect what the adapter reports.

The response body is unchanged — `toErrorResponse` still decides what the client
sees, and a 500 still says only `Internal server error.`

`registerRoutes` gains an optional trailing `onError` parameter on all three
adapters; existing calls are unaffected.
