# @basaltkit/sdk

## 2.1.0

### Minor Changes

- 7363b76: Structured error details — a machine-readable payload on HTTP errors (BK-021).
  
  An error body was `{ error: { code, message } }`, so any data the UI had to act on (which checks failed, how much quota is left, the conflicting field, the current version behind a 409) had to be smuggled into the human-readable message — apps ended up parsing `Checks failed: A, B`.
  
  - **http** — `new HttpError(status, code, message, options?)` takes `HttpErrorOptions` = `{ details?: Record<string, unknown>; cause?: unknown }`. An options object rather than a fourth positional argument, so later additions do not keep widening the signature; the three-argument form is unchanged and adds no `details` key. `toErrorResponse` serializes a sanitised copy as `error.details`, so **fastify, express and hono serve the identical body** (covered by a new `errorDetailsParitySuite` the three adapter packages run).
  - **core** — `BasaltError`'s third argument is now `BasaltErrorOptions` (`ErrorOptions` + `details`), and instances expose `error.details`. Domain packages that throw a `BasaltError` with a numeric `status` (auth, permissions, files, …) can therefore carry details too, and the HTTP serializer picks them up from both. Core never sanitises: it keeps the object exactly as given.
  - **Security rules (documented in the http README, `@basaltkit/core`'s Errors section and the Core concepts guide).** `details` reaches the client verbatim, so the neutral serializer bounds it via the exported `sanitizeErrorDetails` (+ `MAX_ERROR_DETAILS_BYTES` = 4096, `MAX_ERROR_DETAILS_DEPTH` = 8): plain JSON data only (a `Date` becomes its ISO string); functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, `Error`s, `Map`/`Set`/`RegExp`, typed arrays and class instances are stripped rather than rejected (a serialisation slip must not turn a handled 422 into a 500); a dropped array element becomes `null`; a `__proto__` key is never copied; cycles and nesting past the depth cap are dropped; and a payload over 4 KiB of serialised JSON is dropped **whole**, so an error can never become an exfiltration or amplification channel. Only errors explicitly constructed with `details` ever have any — an unexpected exception is still the neutral `500 INTERNAL_ERROR` with nothing attached, and a framework-raised 4xx never grows one. Never put secrets or internals in it.
  - The `RequestValidationError` body is untouched: still exactly `{ code, message, part, issues }`, with no `details` key.
  - **sdk** — `BasaltClientError.errorDetails` returns the server's `error.details` (or `undefined`), instead of making callers dig through `error.details.error.details`; new exported `BasaltErrorBody` type for the full body shape.

## 2.0.1

### Patch Changes

- fb85c40: security: path params are now substituted by whole placeholder name in a single pass, and a missing, empty, `.` or `..` value throws `CLIENT_INVALID_PARAM` before the request is sent, so a param value can no longer redirect an authenticated call to a different same-origin endpoint.
- fb85c40: Security hardening, follow-ups to the outbox (F68) and SDK path-param (F73) fixes:
  
  - events: the outbox relay is fair across tenants, so a tenant whose downstream hangs cannot starve other tenants however many events it emits. When one tenant's backlog fills a page, `flush()` queries again with the tenants already seen excluded, then interleaves the batch round-robin by tenant (each tenant stays FIFO). New `OutboxOptions.tenantConcurrency` (default `ceil(concurrency / 2)`) caps one tenant's in-flight dispatches across flushes. New `dispatchTimeoutMs` (default 10 s, `false` to disable) bounds how long a flush waits on one dispatch. A slower dispatch keeps running detached: it is not cancelled or re-sent, its outcome is still recorded, and `FlushResult.detached` counts it. `OutboxStore.pending()` takes an optional `OutboxPendingFilter` (`excludeTenantIds`, `excludeGlobal`). Custom stores that ignore the filter still work, with fairness limited to one page. Single-tenant apps: tenant-less entries share one `tenantConcurrency` budget, so raise it to keep 8 parallel dispatches.
  - events-sqlite / events-prisma: `pending()` implements the tenant filter NULL-safely.
  - webhooks: `webhookOutboxPlugin` forwards `tenantConcurrency` and `dispatchTimeoutMs` and adds `onFlushError`. A store-level failure on a timer flush no longer becomes an unhandled rejection. `WebhookStore.forEvent(event)` with no tenant (`undefined`, `null` or `''`) is now fail-closed in `MemoryWebhookStore`, `SqliteWebhookStore` and `PrismaWebhookStore`: it returns tenant-agnostic endpoints only. `dispatch(..., { allTenants: true })` reads endpoints through `list()` instead.
  - sdk: a colon inside a path segment is literal again, so Google-style custom methods (`/v1/items:batch`, `/items/:id:archive`) work. Only a `:name` at the start of a segment is a placeholder, and `.`, `..`, empty or missing values are still refused with `CLIENT_INVALID_PARAM`.

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- 36ab1a1: Send native request bodies as-is, and accept an `AbortSignal` and per-call
  headers.
  
  The client always serialised to JSON: it declared `content-type:
  application/json` and called `JSON.stringify` on whatever it was given. Right
  for the common case, wrong for the one the platform already solves — a
  `FormData` upload, where `JSON.stringify(formData)` is `"{}"` and the browser
  has to write the multipart boundary itself, which it only does when
  `content-type` is left alone.
  
  `FormData`, `Blob`, `ArrayBuffer`, `ReadableStream` and `URLSearchParams` now
  pass through untouched, with no content-type imposed. Plain objects are still
  JSON.
  
  `CallInput` also takes `signal` and `headers`. Without a signal, a
  search-as-you-type field fires one request per keystroke and can call none of
  them off — the last answer to arrive wins, which is not the same as the last one
  asked for. Per-call headers merge over the client's; the narrower scope wins,
  the same rule as everywhere else in the client.
  
  No change for existing calls: both fields are optional and JSON bodies behave
  exactly as before.

## 1.0.3

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.3

### Patch Changes

- Do not send `content-type: application/json` on requests with no body — a bodiless POST claiming a JSON content-type made strict servers try to parse an empty payload and fail with a 500.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.1

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).
