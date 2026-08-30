# @basaltkit/hono

## 1.4.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.4.0

### Minor Changes

- a76d591: **Advisory — boot now fails loud when a route declares security meta (`auth`, `can`, `teamRole`) that no registered guard enforces.**
  
  Previously such a route silently served **unprotected**: `meta: { auth: true }` is inert metadata until `authPlugin` registers the guard that reads it, and nothing warned when it was missing. The adapter now calls `assertRoutesGuarded` (from `@basaltkit/http`) before registering routes and refuses to boot, listing every offending route and the plugin that enforces each key.
  
  **If your app fails to boot after upgrading:** register the enforcing plugin (`auth` → `authPlugin`, `can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`) — or, if protection genuinely happens at an outer edge/gateway, opt out explicitly with the new plugin option `allowUnguardedMeta: true` (or `['auth', …]` for specific keys). The default flips from silently-open to fail-loud on purpose: every app this breaks was serving routes it believed were protected.

### Patch Changes

- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.3.0

### Minor Changes

- edb7eef: Neutral JSON 404 for unmatched routes — identical across all adapters.
  
  Unknown routes previously fell through to each framework's default (Fastify's own JSON shape, Express's HTML page, Hono's plain text) — the one divergent surface in the otherwise-uniform `{ error: { code, message } }` contract, and a framework fingerprint. All three adapters now serve the shared `NOT_FOUND_RESPONSE` (new export from `@basaltkit/http`): `404` `{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }`, verified byte-identical by the cross-adapter conformance suite.
  
  Opt out per adapter with `notFound: false`. Overrides: on Fastify a `setNotFoundHandler` registered during a plugin's boot phase wins (the adapter's set is guarded; registering one after `app:booted` requires `notFound: false` — Fastify allows a single handler); on Hono a later `notFound()` call replaces it (last wins); on Express pass `notFound: false` and mount your own catch-all.

### Patch Changes

- Updated dependencies [edb7eef]
  - @basaltkit/http@1.10.0

## 1.2.0

### Minor Changes

- cc2168a: Add typed Server-Sent Events, adapter-agnostic. A handler returns
  `sse(async (stream) => { stream.send(event); … })`; the core encodes the
  `text/event-stream` frames and each adapter renders it against its transport
  (a Node response on Fastify/Express, a `ReadableStream` on Hono). `stream.send`
  (object → JSON, string → data), `close()`, `closed` and `onClose()` (client
  disconnect) work identically everywhere. Exposes `sse`, `isSseResponse`,
  `encodeSseEvent`, `driveSse`, `SSE_HEADERS`.

### Patch Changes

- Updated dependencies [fd5b55c]
- Updated dependencies [cc2168a]
  - @basaltkit/core@1.1.0
  - @basaltkit/http@1.7.0

## 1.1.0

### Minor Changes

- Enforce a request body-size limit (`honoPlugin({ bodyLimit })`, default 1 MiB) — 413 before the body is read.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/http@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/http@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/http@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/http@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/http@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/http@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/http@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/http@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/http@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/http@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/http@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/http@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/http@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/http@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/http@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/http@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/http@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/http@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/http@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/http@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [0f9dbe2]
  - @basaltkit/http@0.5.1
  - @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/http@0.5.0

## 0.4.0

### Minor Changes

- ed43e86: Framework-neutral HTTP core + Express and Hono adapters:

  - New `@basaltkit/http` holds the framework-neutral route pipeline — `route()`, `HttpRequest`/`HttpReply`, validation, enrichers, guards, error mapping (`runRoute`, `toErrorResponse`). Write a route once and run it on any adapter.
  - `@basaltkit/fastify` is refactored to build on `@basaltkit/http` (it re-exports `route`/`HttpError`/`RequestEnricher`/`RouteGuard`, so existing imports keep working) — the handler's `request`/`reply` are now the neutral types.
  - New `@basaltkit/express` and `@basaltkit/hono` adapters run the exact same routes, enrichers and guards. Tenancy, auth, permissions, validation and error shapes are identical across all three frameworks.

- 3e26f2a: Framework-neutral edge plugins. `securityPlugin`, `healthPlugin`, `metricsPlugin`,
  `tracingPlugin` and `openapiPlugin` now target a neutral `HttpServer` (the new
  `HTTP_SERVER` token that every adapter provides), so they run unchanged on
  Fastify, Express and Hono. They moved into `@basaltkit/http` and are re-exported
  from `@basaltkit/fastify` for back-compat. `idempotencyPlugin` stays Fastify-specific
  (it intercepts the response body). Adapters now expose `use`/`after`/`addRoute`
  via an `HttpServerCollector` mounted after all plugins register.

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/http@0.4.0
  - @basaltkit/core@0.4.0
