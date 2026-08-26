<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/core

The foundation of the Basalt framework: the "engine" that boots your application, wires the pieces together (plugins), holds the shared services (container), and maintains the context of each request. You need this whenever you create a Basalt application — every other `@basaltkit/*` package builds on top of it.

## What this module solves

As an application grows, it accumulates many pieces: database, email, job queues, authentication, etc. Without organization, each piece gets wired to the others "by hand", and it becomes hard to know in what order they should start, how they share objects with each other, and how they shut down correctly when the application terminates. `@basaltkit/core` solves exactly that.

The central idea is the **plugin**: a small module with a name (for example `basalt:cache`) that knows how to register its services, start up, and shut down. The application (`createApp`) receives a list of plugins, automatically orders them by their declared dependencies, and runs the full lifecycle: register → boot → (later) shutdown, in the right order.

For plugins to share services without knowing about each other directly, there's the **dependency injection container** (DI for short): a "box" where one plugin places a service identified by a **token** (a typed key) and any other plugin retrieves it by that token. The package also includes: **hooks** (internal notifications between plugins), **per-request context** (data like `requestId` available anywhere in the code), **metrics** in Prometheus format, and **tracing** (operation tracking) compatible with OpenTelemetry — all with no external dependencies.

## Installation

```bash
pnpm add @basaltkit/core
```

Requirements: Node.js (uses `node:async_hooks` and `node:crypto`) and TypeScript. The package is ESM (`"type": "module"`).

## Get started in 5 minutes

Let's create an application with two plugins: one provides a greeting service, and the other uses it.

1. Create a token to identify the service.
2. Create a plugin that registers the service in the container.
3. Create a second plugin that depends on the first and uses the service.
4. Boot the application.

```ts
import { createApp, createToken, definePlugin } from '@basaltkit/core'

// 1. The token is the service's "typed label" in the container.
interface Greeter {
  greet(name: string): string
}
const GREETER = createToken<Greeter>('greeter')

// 2. Plugin that provides the service (register phase: registration only, no I/O).
const greeterPlugin = definePlugin({
  name: 'app:greeter',
  register({ container }) {
    container.singleton(GREETER, () => ({
      greet: (name) => `Hello, ${name}!`,
    }))
  },
})

// 3. Plugin that consumes the service (boot phase: everything is available).
const helloPlugin = definePlugin({
  name: 'app:hello',
  dependsOn: ['app:greeter'], // ensures boot order
  boot({ container }) {
    console.log(container.get(GREETER).greet('Basalt'))
  },
})

// 4. Boot and shutdown.
const app = await createApp({ plugins: [greeterPlugin, helloPlugin] }).boot()
// ... the application runs ...
await app.shutdown()
```

When run, it prints `Hello, Basalt!`. Note that the order in the array doesn't matter: `dependsOn` ensures `app:greeter` registers and boots before `app:hello`.

## Usage guide

### Plugins and lifecycle

A plugin is a simple object with a name and up to three lifecycle functions, all optional:

- `register(context)` — phase 1: place services in the container. No external effects (no network connections, no files).
- `boot(context)` — phase 2: connect to databases, subscribe to hooks, start resources.
- `shutdown(context)` — shut down cleanly. Runs in **reverse order** of startup; if a plugin fails to shut down, the rest still shut down and the errors are aggregated into an `AggregateError`.

The `context` received at each phase has three fields: `container`, `hooks`, and `config` (the plugin's configuration slice, already validated — see below).

```ts
import { definePlugin } from '@basaltkit/core'

const dbPlugin = definePlugin({
  name: 'app:db',
  register({ container }) {
    /* register bindings */
  },
  async boot() {
    /* connect to the database */
  },
  async shutdown() {
    /* close the connection */
  },
})
```

### Validated per-plugin configuration

Each plugin can declare a `configSchema` (a "schema" is a description of the expected data shape, for validation). Any object with a `safeParse` method works — schemas from the [Zod](https://zod.dev) library are compatible. At startup, the `config[pluginName]` slice is validated; if it fails, `boot()` immediately throws `ConfigValidationError` (fail fast, before the application serves requests).

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { z } from 'zod'

const cachePlugin = definePlugin<{ driver: string }>({
  name: 'basalt:cache',
  configSchema: z.object({ driver: z.string() }),
  boot({ config }) {
    console.log(`Cache with driver: ${config.driver}`) // config already typed and validated
  },
})

await createApp({
  plugins: [cachePlugin],
  config: { 'basalt:cache': { driver: 'memory' } }, // keyed by plugin name
}).boot()
```

### Dependency injection container

The container holds "recipes" (*factories*: functions that create the service) associated with tokens. There are three lifetimes (`Lifetime`):

- `singleton` — a single instance for the whole application (the default).
- `scoped` — one instance per scope (for example, per HTTP request), created with `createScope()`.
- `transient` — a fresh instance on every `get()`.

```ts
import { Container, createToken } from '@basaltkit/core'

const COUNTER = createToken<{ n: number }>('counter')
const NAME = createToken<string>('name')

const container = new Container()
container.singleton(NAME, () => 'Basalt')
// The factory receives the container — that's how dependencies are injected:
container.singleton(COUNTER, (c) => ({ n: c.get(NAME).length }))

console.log(container.get(COUNTER).n) // 7

// Scopes (for example, one per request):
container.scoped(COUNTER, () => ({ n: 0 }))
const scopeA = container.createScope()
const scopeB = container.createScope()
scopeA.get(COUNTER).n = 10 // does not affect scopeB
```

The container detects cycles (A needs B which needs A) and throws `CircularDependencyError` with the full chain; an unregistered token throws `UnknownTokenError`.

### Hooks (notifications between plugins)

`HookBus` lets one plugin announce events ("hooks") and others react, without knowing about each other. The application itself emits `app:registered`, `app:booted`, and `app:shutdown`.

```ts
import { HookBus } from '@basaltkit/core'

const hooks = new HookBus()

// Handler with priority: higher values run first (default 0).
const off = hooks.on('app:booted', ({ app }) => {
  console.log('The application has booted!')
}, { priority: 10 })

// Listens to ALL emissions (useful for auditing/devtools); runs after specific handlers.
hooks.onAny((hook, payload) => console.log(`hook: ${hook}`))

await hooks.emit('app:booted', { app })
off() // cancel the subscription
```

Packages can add typed hooks via *module augmentation* (Advanced):

```ts
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'tenancy:switched': { tenantId: string }
  }
}
```

### Per-request context (`ctx`)

The context carries request data (like `requestId`) through the whole call stack, even across `await`s, without manually passing arguments. Uses Node's `AsyncLocalStorage`.

```ts
import { ctx, runWithContext, tryCtx } from '@basaltkit/core'

async function deepService(): Promise<string> {
  // works at any depth, without receiving the id as a parameter:
  return ctx().requestId as string
}

const result = await runWithContext({ requestId: 'req-1' }, async () => {
  return deepService()
})
console.log(result) // 'req-1'

// Outside an active context: ctx() throws ContextUnavailableError; tryCtx() returns undefined.
console.log(tryCtx()) // undefined
```

Concurrent contexts don't mix: each `runWithContext` has its own.

### Human-readable durations

```ts
import { parseDuration } from '@basaltkit/core'

parseDuration('30s')  // 30000 (milliseconds)
parseDuration('1.5d') // 129600000
parseDuration(1500)   // 1500 (numbers pass through directly)
// 'abc', '-5s', NaN → throws BasaltError with code 'DURATION_INVALID'
```

Accepted units: `ms`, `s`, `m`, `h`, `d`.

### Metrics (Prometheus format)

Counters, gauges, and histograms that export as text in [Prometheus](https://prometheus.io) format (a popular monitoring system) — enough for a `/metrics` endpoint.

```ts
import { MetricsRegistry } from '@basaltkit/core'

const registry = new MetricsRegistry()

const requests = registry.counter('http_requests_total', {
  help: 'Total HTTP requests',
  labelNames: ['method'],
})
requests.inc({ method: 'GET' })
requests.inc({ method: 'GET' })

const inFlight = registry.gauge('in_flight')
inFlight.inc() // goes up
inFlight.dec() // goes down
inFlight.set(42)

const duration = registry.histogram('request_duration_seconds', {
  buckets: [0.1, 0.5, 1],
})
duration.observe(0.2)

console.log(registry.render()) // text ready for the /metrics endpoint
```

Requesting a metric with the same name always returns the same instance. Counters reject negative increments.

### Tracing (distributed tracing)

*Tracing* means recording how long each operation (a *span*) took and how they chain across services. The implementation follows the W3C `traceparent` standard and exports to any OpenTelemetry collector via OTLP/HTTP — without installing the OpenTelemetry SDK.

```ts
import { ConsoleSpanExporter, Tracer } from '@basaltkit/core'

const tracer = new Tracer({
  serviceName: 'my-api',
  exporter: new ConsoleSpanExporter(), // prints a summary per span
})

const span = tracer.startSpan('GET /users', { kind: 'server' })
await tracer.inSpan(span, async () => {
  // spans created inside here automatically become children
  const child = tracer.startSpan('db.query')
  child.setAttribute('db.table', 'users')
  child.end()
})
// inSpan ends the span, and marks status 'error' if the function throws
```

For production, use `OtlpHttpExporter` (sends to `http://<collector>:4318/v1/traces` in batches) and, to continue a trace coming from another service, pass `parseTraceparent(headers['traceparent'])` as the span's `parent`.

## API reference

### `createToken<T>(description)` / `Token<T>`

Creates a typed DI token. The type `T` only exists at compile time (there is no runtime reflection). Two tokens with the same description are **different** (each has its own `symbol`).

### `Container`

| Method | Description |
|---|---|
| `register(token, factory, lifetime?)` | Registers a factory. `lifetime` defaults to: `'singleton'`. Returns `this`. |
| `singleton(token, factory)` | Shortcut for `register(..., 'singleton')`. |
| `scoped(token, factory)` | One instance per scope (created in the leaf container). |
| `transient(token, factory)` | A fresh instance on every resolution. |
| `get(token)` | Resolves the service. Throws `UnknownTokenError` or `CircularDependencyError`. |
| `has(token)` | `true` if a binding exists (here or in the parent container). |
| `createScope()` | Creates a child container: inherits bindings, does not inherit `scoped` instances. |

`Factory<T>` = `(container: Container) => T`. `Lifetime` = `'singleton' | 'scoped' | 'transient'`.

### `definePlugin(plugin)` / `BasaltPlugin<TConfig>`

`definePlugin` simply returns the object with typing — it's syntactic sugar for autocompletion.

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes | — | Unique name; convention `basalt:<package>` or `app:<name>`. |
| `dependsOn` | `string[]` | no | `[]` | Plugins that register/boot before this one. |
| `configSchema` | `ConfigSchema<TConfig>` | no | — | Object with `safeParse` (Zod-compatible); validates the config slice. |
| `register` | `(ctx) => void \| Promise<void>` | no | — | Phase 1: register bindings, no I/O. |
| `boot` | `(ctx) => void \| Promise<void>` | no | — | Phase 2: connect resources, subscribe to hooks. |
| `shutdown` | `(ctx) => void \| Promise<void>` | no | — | Shut down; runs in reverse order. |

`PluginContext<TConfig>` = `{ container, hooks, config }`.

### `createApp(options)` / `BasaltApp`

| Option (`CreateAppOptions`) | Type | Required? | Default | Description |
|---|---|---|---|---|
| `plugins` | `BasaltPlugin[]` | no | `[]` | Plugins; topologically ordered by `dependsOn`. |
| `config` | `Record<string, unknown>` | no | `{}` | Raw config, keyed by each plugin's name. |

Members of `BasaltApp`: `container`, `hooks`, `phase` (`LifecyclePhase` = `'created' | 'registering' | 'booting' | 'ready' | 'shutting-down' | 'stopped'`), `boot()` (can only be called once; otherwise throws `LifecycleError`), and `shutdown()` (idempotent). Emitted hooks: `app:registered`, `app:booted`, `app:shutdown`.

### `HookBus`

| Method | Description |
|---|---|
| `on(hook, handler, { priority? })` | Subscribes; higher `priority` runs first (default 0). Returns a function to cancel. |
| `onAny(handler)` | Receives `(hook, payload)` from every emission, after the specific handlers. |
| `emit(hook, payload)` | Runs handlers **in series** by priority; `await`s each one. |

### Context

| Function | Description |
|---|---|
| `ctx()` | The active context (`RequestContext`); throws `ContextUnavailableError` outside a scope. |
| `tryCtx()` | The active context, or `undefined`. |
| `runWithContext(context, fn)` | Runs `fn` with the active context (propagates across `await`s and callbacks). |

`RequestContext` has `requestId?`, `correlationId?`, and accepts extra keys (extensible via *module augmentation*).

### `parseDuration(input)`

`DurationInput` = `number | string`. Converts to milliseconds; throws `BasaltError` (`DURATION_INVALID`) if invalid.

### Errors

All extend `BasaltError`, which has a stable `code` (you can safely do `if (error.code === '...')`):

| Class | `code` |
|---|---|
| `ContextUnavailableError` | `CONTEXT_UNAVAILABLE` |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` |
| `CircularDependencyError` | `DI_CIRCULAR_DEPENDENCY` |
| `PluginDependencyError` | `PLUGIN_DEPENDENCY` |
| `ConfigValidationError` (fields `plugin`, `issues`) | `CONFIG_INVALID` |
| `LifecycleError` | `LIFECYCLE` |

### Metrics

- `MetricsRegistry`: `counter(name, options?)`, `gauge(name, options?)`, `histogram(name, options? & { buckets? })`, `render()`.
- `MetricOptions`: `help?` (default: the name itself), `labelNames?` (default `[]`).
- `Counter.inc(labels?, value?)` — `value` defaults to 1, never negative.
- `Gauge.set(value, labels?)`, `inc(labels?, value?)`, `dec(labels?, value?)`.
- `Histogram.observe(value, labels?)`; `buckets` default `DEFAULT_BUCKETS` (`[0.005 … 10]` seconds).
- `Metric` (abstract class) and `Labels` = `Record<string, string>`.

### Tracing

- `Tracer(options?)` — `TracerOptions`: `exporter?`, `serviceName?` (default `'basalt'`), `sampled?` (default `true`), `clock?` (default `Date.now`), `idGenerator?`.
- `tracer.startSpan(name, { parent?, kind?, attributes? })` — `kind` defaults to `'internal'`; without `parent`, uses the active span as parent.
- `tracer.inSpan(span, fn)` — activates the span, marks `error` if `fn` throws, always ends it.
- `tracer.forceFlush()` — forces the exporter to send.
- `Span`: `setAttribute(key, value)`, `setStatus(status, message?)`, `end()` (idempotent).
- `activeSpan()` — the current span, or `undefined`.
- `parseTraceparent(header)` / `formatTraceparent(context)` — W3C header.
- Exporters (`SpanExporter`): `InMemorySpanExporter` (tests), `ConsoleSpanExporter` (dev), `OtlpHttpExporter` (`OtlpHttpExporterOptions`: `url` required, `serviceName?`, `headers?`, `maxBatch?` default 100, `fetchImpl?`). Sending is *best-effort*: network failures never break the request.
- `toOtlpJson(spans, serviceName)` (Advanced) — serializes to OTLP/JSON format.
- Types: `SpanContext`, `FinishedSpan`, `SpanKind`, `SpanStatus`, `AttributeValue`.

### Metadata (Advanced)

`MetadataRegistry` (`add(bucket, entry)`, `get(bucket)`, `bucketNames()`), the `METADATA` token, and `ensureMetadata(container)` — a central registry of what each plugin declared (routes, commands, schedules), read by tooling (CLI, docs) without importing the producing package.

## Common errors and solutions (FAQ)

**"No provider registered for token …" (`DI_UNKNOWN_TOKEN`)** — You called `container.get(TOKEN)` but no plugin registered that token. Check that the plugin providing it is in the `plugins` list and that the consumer has `dependsOn` pointing to it.

**"ctx() was called outside of an active context" (`CONTEXT_UNAVAILABLE`)** — You called `ctx()` outside `runWithContext`. Wrap the entry point (HTTP handler, worker) with `runWithContext({...}, fn)`, or use `tryCtx()` when a context is optional.

**"boot() called in phase …" (`LIFECYCLE`)** — `boot()` can only be called once per application. Create a new app with `createApp()` if you need to boot again (useful in tests).

**"Plugin X depends on Y, which was not added to the app" (`PLUGIN_DEPENDENCY`)** — Plugin `Y` is missing from the `plugins` array. The same error appears for duplicate plugins and for cycles (`a -> b -> a`).

**"Invalid configuration for plugin …" (`CONFIG_INVALID`)** — The `config['plugin-name']` slice didn't pass `configSchema`. Confirm the key in the `config` object exactly matches the plugin's `name`.

**Two "equal" tokens behave as different ones** — This is intentional: each `createToken` creates a new `symbol`. Export the token from a shared module and import it everywhere, instead of recreating it.

## How it connects to other modules

- **`@basaltkit/config`** — provides `configPlugin`, which registers a `ConfigRepository` in the core container via the `CONFIG` token.
- **`@basaltkit/env`** — uses core's `BasaltError` for its `EnvValidationError`; usually the first step before assembling the `config` object you pass to `createApp`.
- **`@basaltkit/events`** — provides `eventsPlugin` (an event bus on the `EVENTS` token) and `outboxPlugin`; both are core plugins, and the outbox uses `tryCtx()` to read the tenant from the context.
- Any package in the ecosystem extends the `BasaltHooks` and `RequestContext` types via *module augmentation* to add typed hooks and context fields.
