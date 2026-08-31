# Observability

Metrics, health probes, distributed tracing and structured logging ship in the
box — no client libraries, no exporters to install, no OpenTelemetry SDK. Each is
a plugin, and each targets the **framework-neutral `HTTP_SERVER` seam** rather
than Fastify, so the same four lines work on Fastify, Express and Hono. Reach for
this page when you need to answer "is it up?", "how fast is it?" and "what
happened to *this* request?" in production.

[[toc]]

## Mental model

Four plugins, four questions, one shared mechanism:

| Plugin | Answers | Registers | Token |
| --- | --- | --- | --- |
| `metricsPlugin` | How much, how fast, how many in flight? | `GET /metrics` + a pre/after hook pair | `METRICS` |
| `healthPlugin` | Is the process up? Is it ready for traffic? | `GET /livez`, `GET /readyz` | — |
| `tracingPlugin` | Where did *this* request spend its time, across services? | a pre/after hook pair + a flush timer | `TRACER` |
| `loggerPlugin` | What happened, with what identifiers? | nothing HTTP | `LOGGER` |

The first three resolve `HTTP_SERVER` in their `boot()` and register hooks and
routes on it; the adapter (`fastifyPlugin` / `expressPlugin` / `honoPlugin`)
provides that token and mounts everything it collected on `app:booted`. Because
**every plugin's `register` runs before any plugin's `boot`**, their order in the
`plugins` array doesn't matter — but an adapter must be present, and you must
call `boot()`.

`metricsPlugin`, `healthPlugin`, `tracingPlugin`, `METRICS` and `TRACER` live in
**`@basaltkit/http`**, and `@basaltkit/fastify` re-exports them for convenience —
on Express and Hono import them from `@basaltkit/http` directly; the plugins
themselves are identical. The metric and span primitives (`Counter`, `Gauge`,
`Histogram`, `Tracer`, the exporters) come from `@basaltkit/core`. `loggerPlugin`
is its own package, `@basaltkit/logger`, and needs no adapter at all.

## Wiring it all together

```ts
// src/app.ts
import { createApp, OtlpHttpExporter } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY, metricsPlugin, healthPlugin, tracingPlugin } from '@basaltkit/fastify'
import { loggerPlugin } from '@basaltkit/logger'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [/* your routes */] }),
    loggerPlugin({ level: 'info', base: { service: 'acme-api' } }),
    metricsPlugin(),                                        // GET /metrics
    healthPlugin({ checks: { db: () => ({ ok: pool.isHealthy() }) } }), // GET /livez, /readyz
    tracingPlugin({
      serviceName: 'acme-api',
      // set serviceName on the exporter too — that is the one OTLP reports
      exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318', serviceName: 'acme-api' }),
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

::: warning The edge plugins need the adapter
`metricsPlugin`, `healthPlugin` and `tracingPlugin` resolve `HTTP_SERVER` during
`boot()`. Without an adapter registered, that resolve throws
`UnknownTokenError` (`DI_UNKNOWN_TOKEN`) and the app **refuses to boot** — a
loud failure rather than a silently missing `/metrics`. And without `boot()`,
nothing is mounted at all.
:::

::: danger Don't expose the probes to the internet
`/metrics` reveals your route table, traffic shape and error rates; `/readyz`
reveals which dependencies are down. Neither is authenticated. Bind them to an
internal interface, restrict them at the ingress, or move them off the public
path with `metricsPlugin({ path })` / `healthPlugin({ readyPath })`. See
[Security](/guide/security).
:::

## Metrics — `metricsPlugin`

Exposes a Prometheus endpoint and auto-instruments every request:

```ts
import { metricsPlugin } from '@basaltkit/fastify'

metricsPlugin() // serves GET /metrics as text/plain; version=0.0.4
```

Out of the box you get:

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |
| `http_requests_in_flight` | gauge | — |

Requests are labelled by the **route template** the adapter reports
(`/users/:id`), never the raw URL, so label cardinality stays bounded. A request
that matched no route is labelled `unknown` — a single bucket, not one series per
404 URL. The histogram uses the default bucket set
(`0.005 … 10` seconds); `http_requests_in_flight` is incremented in a pre-hook and
decremented in the after-hook, so it also counts requests still being served.

Pass `instrumentHttp: false` to keep the endpoint and drop the automatic HTTP
series, or `registry` to share one `MetricsRegistry` with code that runs outside
the request path (workers, [queues](/guide/queues)).

### Custom metrics

Resolve the registry via `METRICS` and record your own — they render on the same
endpoint. The registry is a get-or-create by name, so calling `counter()` twice
with the same name returns the same instrument rather than clobbering it:

```ts
import { METRICS } from '@basaltkit/fastify'

const jobs = container.get(METRICS).counter('jobs_processed_total', {
  help: 'Background jobs processed',
  labelNames: ['queue'],
})
jobs.inc({ queue: 'emails' })

// histograms take explicit buckets when the defaults don't fit your latencies
const render = container.get(METRICS).histogram('render_seconds', {
  help: 'Template render time',
  buckets: [0.001, 0.005, 0.02, 0.1],
})
render.observe(0.004)
```

`Counter`, `Gauge` and `Histogram` are also exported from `@basaltkit/core` for
use anywhere — they render the Prometheus text exposition format directly. Keep
`labelNames` small and bounded: a label whose value is a user id or a URL is the
usual cause of a metrics backend falling over.

## Health probes — `healthPlugin`

Liveness and readiness are **deliberately distinct**, and they fail differently:

```ts
import { healthPlugin } from '@basaltkit/fastify'

healthPlugin({
  checks: {
    db: () => ({ ok: pool.isHealthy(), detail: 'primary' }),
    redis: async () => ({ ok: await redis.ping().then(() => true).catch(() => false) }),
  },
})
```

- **`GET /livez`** — returns `{ "status": "ok" }` unconditionally. It never
  touches a dependency, so a slow database can't trigger a restart loop.
- **`GET /readyz`** — runs every check **in parallel** and returns `200` only if
  all of them pass, otherwise `503` with a per-check breakdown so a load
  balancer drains the instance instead of sending it traffic.

```json
// GET /readyz  → 503
{ "status": "unavailable", "checks": { "db": { "ok": false }, "redis": { "ok": true } } }
```

::: tip `detail` is for your logs, never for the probe response
A check may return `{ ok, detail }`, but **only `ok` is serialised** — the
response body carries pass/fail per check and nothing else. A check that
*throws* is caught, logged server-side as
`[basalt:health] readiness check "<name>" failed:` with the cause, and reported
as `{ ok: false }`. Both rules exist so an unauthenticated probe can't be turned
into a reconnaissance endpoint that leaks DSN fragments, hostnames or ports.
:::

Keep checks cheap and bounded — they run on every probe, and a check with no
timeout of its own will hold `/readyz` open for as long as the dependency hangs.

## Distributed tracing — `tracingPlugin`

Zero-dependency tracing that speaks W3C trace-context and exports OTLP/JSON to
any OpenTelemetry collector — no OTel SDK required.

```ts
import { tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

tracingPlugin({
  serviceName: 'acme-api',
  exporter: new OtlpHttpExporter({
    url: 'http://otel-collector:4318',   // /v1/traces is appended for you
    serviceName: 'acme-api',
    headers: { authorization: `Bearer ${process.env.OTEL_TOKEN}` },
    maxBatch: 100,
  }),
  flushIntervalMs: 5000,
})
```

Per request the plugin continues an inbound `traceparent` (or starts a new
trace), records a **server span** named `${method} ${routeTemplate}` with
`http.method` / `http.target` attributes, echoes `traceparent` on the response,
then on completion sets `http.status_code`, marks the span `error` for `5xx` and
`ok` otherwise, and ends it. Finished spans are buffered and flushed every
`flushIntervalMs` (the timer is `unref()`ed) plus once more on `app.shutdown()`.

::: warning `serviceName` is set in two places
`tracingPlugin({ serviceName })` names the **`Tracer`**. The name that actually
lands in the OTLP payload's `resource.service.name` comes from the
**exporter's** own `serviceName`, which defaults to `'basalt'`. Set it on both,
or your spans arrive in the collector attributed to `basalt`.
:::

Resolve `TRACER` to wrap your own work in spans — `inSpan` puts the span in
`AsyncLocalStorage`, so anything started inside it is automatically a child:

```ts
import { TRACER } from '@basaltkit/fastify'

const tracer = container.get(TRACER)
await tracer.inSpan(tracer.startSpan('charge.capture', { kind: 'client' }), async () => {
  await gateway.capture(/* … */)
})
```

For local development swap in `ConsoleSpanExporter` (one line per span); in
tests, `InMemorySpanExporter` collects spans for assertions — see
[Testing](/guide/testing). Export failures are swallowed on purpose: tracing must
never break the request path, so a dead collector costs you spans, not requests.

## Logging — `loggerPlugin`

`@basaltkit/logger` wraps Pino: structured JSON logs, per-request context fields
mixed in automatically, and secret redaction on by default.

```ts
import { loggerPlugin, LOGGER } from '@basaltkit/logger'

loggerPlugin({
  level: 'info',            // one of LOG_LEVELS; 'silent' turns logging off
  pretty: true,             // human-readable dev output (needs pino-pretty)
  redact: ['user.ssn'],     // extra paths, added to the defaults
  base: { service: 'api' }, // fixed fields on every line
})

// anywhere:
container.get(LOGGER).info({ orderId }, 'order placed')
```

Every line automatically carries whatever the active
[context](/guide/concepts) holds: `requestId`, `correlationId`, `traceId`,
`userId` and `tenantId` — plus `tenant.id` / `user.id` promoted to
`tenantId` / `userId` when only the objects are set. You never pass them in a log
call. Outside a context (a boot-time log, a script) the mixin contributes
nothing rather than throwing.

::: tip Redaction is on by default, and it is not just `password`
Values are replaced with `[REDACTED]` for `password`, `pass`, `secret`, `token`,
`accessToken`, `refreshToken`, `idToken`, `jwt`, `apiKey`, `api_key`, `apikey`,
`mfaCode`, `otp`, `resetToken`, `authorization`, `cookie`, `creditCard`,
`cardNumber`, `cvv`, `cvc` and `ssn` — at the top level **and** one level of
nesting (`*.token`), plus the usual request-shaped paths
(`req.headers.authorization`, `headers["set-cookie"]`, …). `redact` **adds** to
that list; it never replaces it. Anything deeper than one level needs an explicit
path.
:::

Mail bodies are a separate problem with a separate switch: the mailer's `log`
driver redacts message bodies in production because they carry reset links and
magic links. That's `logBody` on `mailerPlugin`, not a logger option — see
[Notifications](/guide/notifications).

### Log levels are typed

`level` is the union **`LogLevel`** — not a free string — so a typo fails to
compile. From most to least severe:

`'fatal'` · `'error'` · `'warn'` · `'info'` (default) · `'debug'` · `'trace'` · `'silent'`

Reuse the same type and values (`LogLevel` / `LOG_LEVELS`) for your own options
and env validation, so a wrong level is caught in code **and** at boot:

```ts
import { z } from 'zod'
import { defineEnv } from '@basaltkit/env'
import { LOG_LEVELS, type LogLevel } from '@basaltkit/logger'

// env — an invalid LOG_LEVEL is rejected at startup
const env = defineEnv({ LOG_LEVEL: z.enum(LOG_LEVELS).default('info') })

// your own option — an invalid level is a compile error
interface BuildAppOptions { logLevel?: LogLevel }
```

`'silent'` disables all output — handy for CLI commands and tests. It's part of
`LogLevel` (Pino's own `Level` type omits it). See [Configuration](/guide/config)
for the env plumbing.

## HTTP errors — `onError` on the adapter

A request that fails is reported by the adapter: **5xx to `error` carrying the
error object** (the stack is the point — it is a bug) and **4xx to `warn` with
its code and reason** (a validation failure's stack is noise). Both go through
the same policy on Fastify, Express and Hono.

Reports are **structured**, never an interpolated sentence: the sink is called as
`(fields, message)` — pino's own signature — where `message` is always a literal
and the request data lives in `fields`. That is a security property as much as a
formatting one: a `%s` or a newline in a URL can never reach a format string, so
format-string injection and log forging are removed rather than escaped.

```ts
fastifyPlugin({
  routes,
  onError: ({ error, status, code, method, url }) => {
    logger.error({ err: error, status, code, method, url }, 'request failed')
  },
})
```

Pass `() => {}` to silence them. The same option exists on `expressPlugin` and
`honoPlugin`.

**Where the default writes.** On Fastify it is Fastify's own logger, so records
stay structured for apps that configured pino — and the console for apps that
did not, since a server built with `logger: false` (Fastify's default) installs
a no-op logger that would swallow the report. Express and Hono use the console.

::: warning Two loggers, not one
Fastify's logger and `@basaltkit/logger` are separate systems. The `LOGGER`
token is for your own code; the adapter's default writes to Fastify's. Setting a
level on `loggerPlugin` does **not** change what the adapter reports — wire
`onError` to your logger if you want them in one place.
:::

**Client errors are reported too, deliberately.** They used to be silent, which
is defensible for a 404 from a scanner and useless while you are trying to work
out why your own request came back 400 with nothing in the terminal. If that is
noisy for you, filter in your own reporter — the decision belongs to the app,
not to the framework's default.

The response body never changes: `toErrorResponse` decides what the client sees,
and a 500 still says only `Internal server error.`

## Request correlation

Every request carries a `requestId` and a `correlationId` in the
[context](/guide/concepts), which means they appear on every log line and can be
propagated across services. Forward the incoming `x-request-id` /
`x-correlation-id` headers on outbound calls and one identifier follows a
user action through every hop; pair it with the `traceparent` that
`tracingPlugin` echoes and you can jump from a log line to the trace.

The same identifiers are what make the async surfaces legible: put your logger
behind the realtime `onBridgeError` / `onDeliveryError` callbacks
([Realtime](/guide/realtime)), the outbox's `onDead` / `onFlushError`
([Persistence](/guide/persistence)) and the queue's `onError` / `onJobFailed`
([Queues](/guide/queues)) instead of leaving them on `console.error`. The HTTP
adapter's own `onError` (above) is the same family.

## Options reference

`metricsPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `path` | `string` | `'/metrics'` | Move the scrape endpoint off a path your ingress exposes publicly |
| `registry` | `MetricsRegistry` | a new one | Share one registry with non-HTTP code (workers, jobs) so everything renders on one endpoint |
| `instrumentHttp` | `boolean` | `true` | `false` keeps `/metrics` but drops the automatic `http_*` series |

`MetricsRegistry` instruments — `counter(name, opts)`, `gauge(name, opts)`,
`histogram(name, opts)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `help` | `string` | the metric name | The `# HELP` line in the exposition |
| `labelNames` | `string[]` | `[]` | Declared label keys; keep the value space bounded |
| `buckets` | `number[]` | `DEFAULT_BUCKETS` (`0.005 … 10`) | Histograms only — match your actual latency range |

`healthPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `checks` | `Record<string, () => HealthReport \| Promise<HealthReport>>` | `{}` | Readiness checks, run in parallel; a report is `{ ok, detail? }` and only `ok` is serialised |
| `livePath` | `string` | `'/livez'` | Match your orchestrator's liveness probe path |
| `readyPath` | `string` | `'/readyz'` | Match your orchestrator's readiness probe path |

`tracingPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'basalt'` | Names the `Tracer`. The OTLP `service.name` comes from the **exporter** — set both |
| `exporter` | `SpanExporter` | none | Where finished spans go; without one, spans are recorded and dropped |
| `tracer` | `Tracer` | built from the options above | Bring your own `Tracer` (custom sampling, clock, id generator) |
| `flushIntervalMs` | `number` | `5000` | Export cadence; the timer is `unref()`ed and a final flush runs on shutdown |

`new OtlpHttpExporter(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `url` | `string` | — (**required**) | Collector base URL; `/v1/traces` is appended and a trailing slash stripped |
| `serviceName` | `string` | `'basalt'` | The `resource.service.name` reported to the collector |
| `headers` | `Record<string, string>` | `{}` | Authentication for a hosted collector |
| `maxBatch` | `number` | `100` | Flush as soon as the buffer reaches this size |
| `fetchImpl` | `typeof fetch` | global `fetch` | Inject a client (proxying, tests) |

`new Tracer(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `exporter` | `SpanExporter` | none | Destination for finished spans |
| `serviceName` | `string` | `'basalt'` | Name carried on the tracer |
| `sampled` | `boolean` | `true` | `false` emits `traceflags: 00`, telling downstream services not to sample |
| `clock` | `() => number` | `Date.now` | Injectable clock (tests) |
| `idGenerator` | `{ traceId(): string; spanId(): string }` | random hex | Deterministic ids in tests |

`loggerPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `level` | `LogLevel` | `'info'` | Minimum severity; `'silent'` disables output entirely |
| `pretty` | `boolean` | `false` | Human-readable dev output — requires `pino-pretty` to be installed |
| `redact` | `string[]` | `[]` | Paths **added** to the built-in redaction list, for your own secret-bearing fields |
| `base` | `Bindings` | `{}` | Fixed fields on every line (`service`, `version`, region…) |
| `destination` | `DestinationStream` | stdout | Route output elsewhere — a file, a transport, a test buffer |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | boot | `metricsPlugin` / `healthPlugin` / `tracingPlugin` registered without an adapter, or `METRICS` / `TRACER` / `LOGGER` resolved without their plugin |
| — (readiness failure) | — | 503 | One or more `/readyz` checks returned `ok: false` **or threw**; the body names which |
| Check threw | logged `[basalt:health] readiness check "<name>" failed:` | 503 | The cause is server-side only — the response says `{ ok: false }` and nothing more |
| `Error: unable to determine transport target for "pino-pretty"` | — | boot | `pretty: true` without `pino-pretty` installed |
| Silent span loss | — | — | The OTLP exporter swallows transport errors by design; a dead collector costs spans, never requests |

- **`/metrics` returns 404** — no adapter was registered, `boot()` was never
  called, or `path` was changed. Plugin *order* is not the cause: every
  `register` runs before any `boot`.
- **Spans arrive attributed to `basalt`** — `serviceName` was set on
  `tracingPlugin` but not on the exporter. The exporter's own `serviceName` is
  what fills `resource.service.name`.
- **Traces stop at the service boundary** — the caller didn't forward
  `traceparent`. The plugin echoes it on responses, but outbound requests are
  yours to propagate.
- **Prometheus falls over after a deploy** — a new label carries an unbounded
  value (user id, path, error message). The built-in HTTP series are safe because
  they use the route template; custom instruments are not policed.
- **Log lines have no `tenantId`/`userId`** — the log was emitted outside a
  request context, or tenancy/auth hadn't populated it yet. The mixin contributes
  only what the context already holds.
- **A secret appeared in the logs** — it was nested more than one level deep, or
  the key isn't in the default list. Add the explicit path with `redact`; and if
  it was an email body, that's the mailer's `logBody`, in
  [Notifications](/guide/notifications).
- **`/readyz` hangs** — a check has no timeout of its own. Wrap slow
  dependencies with one; `healthPlugin` awaits whatever you give it.

For the deployment-time checklist that ties these together, see
[Going to Production](/guide/production).
