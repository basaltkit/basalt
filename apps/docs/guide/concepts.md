# Core Concepts

Everything in Basalt is built on a small foundation: an application with a
plugin lifecycle, a dependency-injection container, a request context that
flows through the whole call stack, and a handful of **string-keyed metadata
buckets** that let packages cooperate without importing each other. This page
is the official reference for those internals — enough to write a third-party
Basalt package from the docs alone.

[[toc]]

## The application

`createApp` assembles plugins and boots them in dependency order.

```ts
import { createApp } from '@basaltkit/core'

const app = await createApp({
  plugins: [configPlugin, loggerPlugin, tenancyPlugin, authPlugin],
}).boot()

// ... later, graceful shutdown (reverse boot order)
await app.shutdown()
```

`app.container` is the root DI container; `app.hooks` is the shared
`HookBus`. `dependsOn` produces a topological boot order; a cycle is a startup
error that names the cycle.

## Plugins — the unit of composition

A plugin is what every package ships. It declares dependencies, registers
services, and connects resources — in **three phases**:

| Phase | When | What belongs here | What must NOT happen here |
|---|---|---|---|
| `register` | for every plugin, before any `boot` | container bindings (`container.singleton(...)`), metadata contributions (`ensureMetadata(container).add(...)`) | **No I/O, no side effects** — no connections, no listeners, no resolving other plugins' services |
| `boot` | after every plugin registered, in dependency order | connect resources, subscribe to hooks, start servers/workers | registering new bindings other plugins were supposed to see |
| `shutdown` | reverse boot order | close connections, flush buffers | — |

```ts
import { definePlugin, createToken, ensureMetadata } from '@basaltkit/core'

export const MAILER = createToken<Mailer>('mailer')

export const mailerPlugin = definePlugin({
  name: 'basalt:mailer',        // convention: basalt:<package> or app:<name>
  dependsOn: ['basalt:config'], // boots after config
  register({ container, config }) {
    container.singleton(MAILER, () => new SmtpMailer(config))
  },
  async shutdown({ container }) {
    await container.get(MAILER).close()
  },
})
```

Each phase receives a `PluginContext`: `{ container, hooks, config }`. An
optional `configSchema` (anything with Zod's `safeParse` shape) validates the
plugin's config slice at boot — fail fast, before traffic.

::: warning The register-phase rule is load-bearing
`register` runs for **all** plugins before any `boot`. Metadata written in
`register` (guards, enrichers, claims) is guaranteed visible to every consumer
that reads it in `boot` — that ordering is what the whole cooperation model
below relies on. A plugin that does I/O or resolves services in `register`
breaks that guarantee for everyone.
:::

## Dependency injection without decorators

The container uses **typed tokens and factory functions** — no decorators, no
`reflect-metadata`. The dependency graph is explicit, works on any bundler and
runtime, and tree-shakes.

```ts
import { createToken } from '@basaltkit/core'

const REPORTS = createToken<Reports>('reports')          // Token<Reports>
container.singleton(REPORTS, (c) => new Reports(c.get(MAILER)))
const reports = container.get(REPORTS)                    // fully typed
```

### Lifetimes

| Lifetime | Registered with | One instance per… | Typical use |
|---|---|---|---|
| `singleton` | `container.singleton(token, factory)` | application | services, drivers, clients |
| `scoped` | `container.scoped(token, factory)` | request scope (`createScope()`) | per-request state, per-request DB client |
| `transient` | `container.transient(token, factory)` | resolution — a fresh instance every `get()` | stateless helpers |

`container.has(token)` checks reachability; `container.createScope()` opens a
child scope (the HTTP pipeline does this per request — you rarely call it
yourself). Factories receive the **resolving** container, so a scoped
resolution inside a request sees that request's scope.

### Lifetimes are enforced — `DI_CAPTIVE_DEPENDENCY`

A `singleton` outlives every request scope, so its factory must not resolve
`scoped` tokens — that would freeze one request's instance into an app-wide
service (request 1's user leaking into every later request). The container
fails loudly with `CaptiveDependencyError` (code `DI_CAPTIVE_DEPENDENCY`)
instead of capturing silently. Resolve scope-dependent services at **use
time** (from `ctx().container`) rather than at construction:

```ts
// ❌ throws DI_CAPTIVE_DEPENDENCY at boot — scoped token inside a singleton factory
container.singleton(REPORTS, (c) => new Reports(c.get(REQUEST_USER)))

// ✅ resolve per use, inside the request
container.singleton(REPORTS, () => new Reports(() => ctx().container.get(REQUEST_USER)))
```

### Inspecting the container (devtools)

```ts
import { renderDependencyGraph } from '@basaltkit/core'

container.describe()      // every reachable binding: token, lifetime, built?
container.enableGraph()   // opt-in; zero overhead when off
// … boot the app / run some requests …
const graph = container.dependencyGraph()  // { nodes, edges } observed so far
console.log(renderDependencyGraph(graph))  // Mermaid — paste into any viewer
```

`describe()` is a static snapshot; the dependency graph is **passive** — it
records real `A depends on B` resolutions since `enableGraph()` and never
forces eager construction.

## Context (AsyncLocalStorage)

`ctx()` returns the active request/job context anywhere in the call stack —
handlers, services, jobs, listeners — without passing parameters. It carries
the request id, correlation id, the current tenant, the authenticated user,
the scoped container and the scoped database client.

```ts
import { ctx, tryCtx, runWithContext } from '@basaltkit/core'

export async function anyService() {
  const { tenant, user, logger } = ctx() // throws ContextUnavailableError outside a context
  logger.info('processing')              // already tagged with tenantId + requestId
}

tryCtx()                                  // …or undefined outside a context, no throw
await runWithContext({ tenant }, () => runJobForTenant()) // give background work a context
```

This is the backbone that lets cache, storage, queue, logger and the data
drivers isolate per tenant automatically — they all read the tenant from the
context, so your code never threads it through by hand. Background jobs run
**outside** request context: wrap them in `runWithContext` when they act for a
specific tenant (tenant-scoped packages fail closed without it — e.g. the
cache throws `MissingCacheScopeError` in multi-tenant apps; see
[Caching](/guide/caching)).

## Metadata buckets — how packages cooperate

A `MetadataRegistry` hangs off the root container
(`ensureMetadata(container)`), with two operations: `add(bucket, entry)` and
`get<T>(bucket): T[]`. Buckets are **plain strings**, so packages contribute
and consume each other's extension points with zero import coupling. These are
the official buckets:

| Bucket | Entry type | Written by | Read by |
|---|---|---|---|
| `http:enrichers` | `RequestEnricher` | tenancy, auth, anything context-building | the HTTP adapters (every request, before guards) |
| `http:guards` | `RouteGuard` | auth, permissions, teams, your plugins | the HTTP adapters (every request, after enrichers) |
| `http:guarded-meta` | `string` (a meta key) | every plugin whose guard **enforces** a security meta key | the adapters' boot check (below) |
| `http:routes` | route descriptors | the adapters at boot | OpenAPI, the CLI (`basalt routes`), the SDK |
| `commands` | `CommandDefinition` (structural) | any package shipping CLI commands | `@basaltkit/cli` |
| `schedule:entries` | schedule descriptors | the scheduler | CLI `schedule:list` tooling |
| `tenancy:active` | `true` | `tenancyPlugin` | packages adopting tenant-safe defaults (first consumer: cache) |

Contribute in `register`, consume in `boot` — the phase ordering guarantees
visibility.

## The neutral route pipeline

Routes are defined once with `route()` from `@basaltkit/http` and run
identically on Fastify, Express and Hono — the adapters translate their native
request/reply into a neutral shape and call the same `runRoute`. Per request,
in order:

1. **Request context** created (request id, correlation id) with a fresh
   **scoped container** (`createScope()`).
2. **Enrichers** run (`http:enrichers`) — build the context: tenancy sets
   `ctx().tenant`, auth sets `ctx().user`. An enricher receives
   `{ request, context, container }`.
3. **Guards** run (`http:guards`) — authorize: a guard receives
   `{ route, request, context, container }`, reads the route's `meta`, and
   rejects by **throwing**. Auth reads `meta.auth`, permissions reads
   `meta.can`, teams reads `meta.teamRole`, API keys read `meta.scopes`, and
   subscriptions read `meta.subscribed`/`meta.feature`.
4. **Validation** — `body`, `query` and `params` are `safeParse`d against the
   route's Zod schemas; a failure is a `RequestValidationError`
   (`HTTP_VALIDATION`, 400) with per-field issues.
5. **Handler** runs with the typed, validated parts.
6. **Response** — the return value is sent (unless the handler already
   replied); ETags/304 are handled; unmatched routes get the shared neutral
   404 body (`NOT_FOUND_RESPONSE`: `{ error: { code: 'NOT_FOUND', … } }`) on
   every adapter.

### The error model

Every framework error extends `BasaltError` — `code` (stable, machine-readable)
plus `message`. HTTP-facing errors carry a `status`; `toErrorResponse` maps any
thrown error to the standard body `{ error: { code, message, … } }`. Throw
`HttpError(status, code, message)` for intentional HTTP errors from any layer.
Unknown/unexpected errors become a 500 **without leaking the internal
message**. Codes you'll meet in these docs are real and stable — e.g.
`AUTH_REQUIRED`, `PERMISSION_DENIED`, `PERMISSION_META_INVALID`,
`TENANT_REQUIRED`, `TEAM_NOT_A_MEMBER`, `DI_CAPTIVE_DEPENDENCY`,
`HTTP_VALIDATION`, `NOT_FOUND` — treat them as API.

### Security meta must be enforced — the boot check

`meta: { auth: true }`, `meta.can`, `meta.teamRole`, `meta.scopes`,
`meta.subscribed` and `meta.feature` are *requests* for protection; the guard a plugin registers is what enforces them. At boot the
adapters verify every declared security meta key has a registered guard
claiming it (via `http:guarded-meta`) and refuse to start otherwise
(`UnguardedRouteMetaError`), listing every offending route. Escape hatch for
edge-authenticated deployments: `allowUnguardedMeta: true | ['auth', …]` on
the adapter plugin. Details in [Security](/guide/security#authorization-is-explicit).

## Writing your own guard or enricher

A complete third-party package that protects routes with `meta.approved`:

```ts
import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { HttpError, type RequestEnricher, type RouteGuard } from '@basaltkit/http'

export const approvalPlugin = definePlugin({
  name: 'acme:approval',
  register({ container }) {
    const metadata = ensureMetadata(container)

    // Enricher: contexts are built here, never in guards.
    const enricher: RequestEnricher = async ({ request, context }) => {
      ;(context as { approved?: boolean }).approved =
        request.headers['x-approval'] === 'granted'
    }
    metadata.add('http:enrichers', enricher)

    // Guard: reads route meta, rejects by throwing.
    const guard: RouteGuard = ({ route, context }) => {
      if (route.meta?.['approved'] === true && !(context as { approved?: boolean }).approved) {
        throw new HttpError(403, 'APPROVAL_REQUIRED', 'This action needs approval.')
      }
    }
    metadata.add('http:guards', guard)
  },
})
```

Rules of the road: enrichers **build** context, guards **decide** — keep the
two separate; guards must be cheap (they run on every matching request) and
must **fail closed** (an unenforceable declaration is an error, not a skip); if
your guard enforces one of the framework security keys, claim it —
`metadata.add('http:guarded-meta', '<key>')` — so the boot check knows.

## The adapter contract

An HTTP adapter package (what `@basaltkit/fastify`, `express`, `hono` each do —
and what a new one must do):

1. `register`: bind the native server under its token, and an
   `HttpServerCollector` under `HTTP_SERVER` (edge plugins — security headers,
   rate limits — contribute pre/after hooks through it).
2. `boot`: read `http:enrichers` + `http:guards`, run the
   `assertRoutesGuarded` boot check, register every route so requests flow
   through the neutral `runRoute` (context → enrichers → guards → validation →
   handler), publish descriptors on `http:routes`, mount the collector's edge
   hooks on `app:booted`, and serve the neutral 404.
3. `shutdown`: close the server.

Features target the neutral contract, never one adapter — a CI boundary test
enforces that runtime feature packages don't import an adapter.

## Hooks (HookBus)

Where the container shares *services*, the **HookBus** shares *moments*. One
plugin announces that something happened; others react — without importing
each other. Every app carries one at `app.hooks`, and each plugin receives it
in its lifecycle context. The app emits `app:registered`, `app:booted`,
`app:shutdown`; packages add their own typed hooks via module augmentation
(auth emits `auth:password_reset_requested`, teams emits `team:joined`, and so
on — each package's guide lists its hooks).

```ts
import { definePlugin } from '@basaltkit/core'

export const emailOnResetPlugin = definePlugin({
  name: 'app:reset-email',
  dependsOn: ['basalt:auth'],
  boot({ hooks }) {
    // subscribe in the boot phase; `on` returns an unsubscribe function
    hooks.on('auth:password_reset_requested', async ({ user, token }) => {
      await sendEmail(user.email, `https://app.example.com/reset?token=${token}`)
    })
  },
})
```

`hooks.on(hook, handler, { priority })` runs higher-priority handlers first;
`hooks.emit(hook, payload)` awaits handlers **in series**; and
`hooks.onAny((hook, payload) => …)` sees every emission after the specific
handlers — the hook devtools and audit trail hang off that.

**Handlers are isolated.** One handler's failure never starves the remaining
handlers or the `onAny` observers — every registered handler always runs.
Failures still surface to the emitter afterwards: a single failure rethrows
the original error, several become an `AggregateError`. Nothing is swallowed
silently. (Cosmetic listeners — realtime pushes, notifications — additionally
decouple with fire-and-log so they can never fail a domain write; see
[Realtime](/guide/realtime).)

::: tip Hooks vs. events
**Hooks** (`@basaltkit/core`) are framework extension points — internal
moments plugins wire into. **Events** (`@basaltkit/events`, below) are your
*domain* events, validated with Zod and meant for application logic.
:::

## Events

Domain events are typed and decoupled. Cross-cutting concerns like audit
subscribe with wildcards instead of touching every call site.

```ts
import { defineEvent, on } from '@basaltkit/events'
import { z } from 'zod'

export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

on(OrderCreated, async ({ orderId }) => { /* ... */ })
on('order.*', auditListener) // wildcard
```

For durable, at-least-once delivery (an event that must survive a crash
between the write and the publish), pair the bus with the **outbox** — see
[Persistence](/guide/persistence).

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| `DI_CAPTIVE_DEPENDENCY` at boot | a singleton factory resolved a `scoped` token | resolve at use time via `ctx().container` (see [Lifetimes](#lifetimes-are-enforced-di-captive-dependency)) |
| `UnguardedRouteMetaError` at boot | a route declares a guarded key (`meta.auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) but the enforcing plugin isn't registered | register `authPlugin`/`permissionsPlugin`/`teamsPlugin`, or opt out with `allowUnguardedMeta` |
| `ContextUnavailableError` | `ctx()` called outside any request/job context | use `tryCtx()`, or wrap background work in `runWithContext` |
| plugin boot error naming a cycle | `dependsOn` forms a loop | break the cycle — usually by moving a subscription from `register` to `boot` |
| `HTTP_VALIDATION` (400) | request body/query/params failed the route's Zod schema | the response lists the failing part and per-field issues |
