# Observability

Metrics, health probes and distributed tracing ship in the box — no client
libraries, no exporters to install. Each is a Basalt plugin; they mount their
hooks and routes on boot, so they need `fastifyPlugin` (or the Express/Hono
adapter) present and `boot()` called.

[[toc]]

## Wiring it all together

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { metricsPlugin, healthPlugin, tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [/* your routes */] }),
    metricsPlugin(),                                   // GET /metrics
    healthPlugin({ checks: { db: () => ({ ok: true }) } }), // GET /livez, /readyz
    tracingPlugin({
      serviceName: 'acme-api',
      exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318' }),
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

Each plugin is detailed below. `metricsPlugin`, `healthPlugin`, `tracingPlugin`,
`METRICS` and `TRACER` are re-exported from `@basaltkit/fastify` (they live in
`@basaltkit/http`); the metric and span primitives and exporters come from
`@basaltkit/core`.

::: warning Edge plugins need the adapter
Their hooks and routes are mounted on the `app:booted` event, so `/metrics`,
`/readyz` and tracing only respond when `fastifyPlugin` is present and you called
`boot()`.
:::

## Metrics — `metricsPlugin`

Exposes a Prometheus `/metrics` endpoint and auto-instruments every request.

```ts
import { metricsPlugin } from '@basaltkit/fastify'

metricsPlugin() // serves GET /metrics
```

Out of the box you get:

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |
| `http_requests_in_flight` | gauge | — |

Requests are labelled by **route template** (`/users/:id`), never the raw URL,
so label cardinality stays bounded.

### Custom metrics

Resolve the registry via the `METRICS` token and record your own — they render
on the same `/metrics` endpoint.

```ts
import { METRICS } from '@basaltkit/fastify'

const jobs = container.get(METRICS).counter('jobs_processed_total', {
  help: 'Background jobs processed',
  labelNames: ['queue'],
})
jobs.inc({ queue: 'emails' })
```

`Counter`, `Gauge` and `Histogram` are also exported from `@basaltkit/core` for
use anywhere — they render the Prometheus text exposition format directly.

## Health probes — `healthPlugin`

Liveness and readiness are **deliberately distinct**:

```ts
import { healthPlugin } from '@basaltkit/fastify'

healthPlugin({
  checks: {
    db: () => ({ ok: pool.isHealthy(), detail: 'primary' }),
    redis: async () => ({ ok: await redis.ping().then(() => true).catch(() => false) }),
  },
})
```

- **`GET /livez`** — the process is running. Never touches dependencies, so a
  slow database can't trigger a restart loop.
- **`GET /readyz`** — every registered check passes. Returns `503` with a
  per-check breakdown otherwise, so a load balancer drains the instance instead
  of sending it traffic.

```json
// GET /readyz  → 503
{ "status": "unavailable", "checks": { "db": { "ok": false, "detail": "primary" }, "redis": { "ok": true } } }
```

## Distributed tracing — `tracingPlugin`

Zero-dependency tracing that speaks W3C trace-context and exports OTLP to any
OpenTelemetry collector — no OTel SDK required.

```ts
import { tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

tracingPlugin({
  serviceName: 'acme-api',
  exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318' }),
})
```

`url` is the collector's base URL — the OTLP path `/v1/traces` is appended for
you. Pass `headers` for an authenticated collector, and `maxBatch` (default 100)
to tune flushing.

Per request it continues an inbound `traceparent` (or starts a new trace),
records a **server span** labelled by route template with HTTP attributes and
status, echoes `traceparent` on the response, and exports the finished span.
Resolve the `TRACER` token to wrap your own work in spans:

```ts
import { TRACER } from '@basaltkit/fastify'

const tracer = container.get(TRACER)
await tracer.inSpan(tracer.startSpan('charge.capture', { kind: 'client' }), async () => {
  await gateway.capture(...)
})
```

For local development, swap in `ConsoleSpanExporter`; in tests,
`InMemorySpanExporter` collects spans for assertions.

## Request correlation

Every request also carries a `requestId` and `correlationId` in the
[context](/guide/concepts) and structured logs (`@basaltkit/logger`). Propagate
the incoming `x-request-id` / `x-correlation-id` headers across services to
trace a call end to end.
