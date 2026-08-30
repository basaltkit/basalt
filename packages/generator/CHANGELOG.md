# @basaltkit/generator

## 1.2.1

### Patch Changes

- 59cf29c: Read `--no-register` / `--no-migrate` through the CLI's new flag negation.
  
  `@basaltkit/cli`'s `parseArgv` now parses a bare `--no-<name>` as `<name>: false`. These commands checked the literal `flags['no-register']` / `flags['no-migrate']` key, which that change would have made permanently absent — silently re-enabling the very behavior the flag suppresses. Both now check the negated form, and still accept the legacy literal key for programmatic callers.
- Updated dependencies [59cf29c]
  - @basaltkit/cli@1.2.2

## 1.2.0

### Minor Changes

- 552cbe8: AI MCP bridge — M3 (safe make), RFC 0001 §E / §D.1(3).
  
  - **`@basaltkit/ai`** adds a safe-preview to `runMake`: a dry-run now stats every target and returns `MakeResult.preview.perFile[]` (`{ path, action: 'create' | 'overwrite', diff }`) with unified diffs, plus `preview.clashes`. The preview writes nothing; `prisma db push`/`migrate` stays strictly opt-in. New `FilePreview`/`MakePreview` types and a dependency-free unified-diff generator. `runMake` (and its make types) are now reachable from the framework-free `@basaltkit/ai/workflows` subpath.
  - **`@basaltkit/generator`** adds a framework-free **`@basaltkit/generator/resource`** subpath exposing `generateResource`/`writeGenerated`/`registerResourceInApp`/`names`/`FileExistsError` (+ types) **without** `generatorCommands` — which imports `@basaltkit/cli` (→ `@basaltkit/core`). `@basaltkit/ai`'s make engine now imports this subpath, so `runMake` no longer pulls the framework runtime, and dev-only consumers stay boundary-clean.
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains the `basalt_make` tool with a safety layer (`src/safety.ts`): **preview is the default and writes nothing**; `mode:'apply'` is explicit and refuses to overwrite a clash unless `force:true`; `prisma db push` runs only when `migrate:true` (double-gated); all writes are **confined to the launch workspace** (rejects `../` traversal, absolute paths, and symlink escapes before any write); an `apply` is confirmed via MCP elicitation when the client supports it, with the explicit preview→apply two-call flow as the floor. Plan↔make correlation is stateless — the client carries the full `ArchitecturePlan`. Progress via `ctx.progress`, cancellation via `ctx.signal`.

## 1.1.1

### Patch Changes

- `registerResourceInApp` now wires routes even when `fastifyPlugin` has options
  before `routes:` — e.g. `fastifyPlugin({ fastify: { logger: … }, routes: […] })`.
  The anchor previously required `routes:` to be the first key and silently fell
  back to "not auto-wired", forcing a manual edit.

## 1.1.0

### Minor Changes

- **`make:resource` now generates `createdAt` + `updatedAt` by default** (schema,
  Prisma model with `@updatedAt`, and both repositories).
- **New `--soft-delete` flag**: adds a `deletedAt` column, makes `delete` a soft
  delete, hides soft-deleted rows from `list`/`find`, and generates a `restore()`
  method plus a `POST /…/:id/restore` route.
- **Fix:** the Prisma repository now maps the row's `Date` timestamps to the API
  type's ISO strings (via a `to<Name>` mapper). Before, the generated
  `PrismaRepository` returned raw `Date` columns and failed to typecheck against
  the schema's string timestamps.

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

- @basaltkit/cli@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/cli@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/cli@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/cli@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/cli@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/cli@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/cli@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/cli@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/cli@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/cli@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/cli@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/cli@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/cli@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/cli@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/cli@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/cli@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/cli@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/cli@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/cli@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/cli@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/cli@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/cli@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/cli@0.4.0

## 0.3.0

### Minor Changes

- 4846bc1: `basalt make:resource --prisma` (and per-artifact `make:repository --prisma`)
  generates a Prisma-backed repository using `db<PrismaClient>()` plus a
  `.prisma` model block to paste into schema.prisma, and wires the Prisma
  repository in the generated plugin — closing the loop to real persistence
  (incl. database-per-tenant). The default stays in-memory.

### Patch Changes

- @basaltkit/cli@0.3.0

## 0.2.0

### Minor Changes

- `basalt make:resource` now auto-wires the generated resource into `src/app.ts`: it adds the plugin + routes imports, registers the plugin in the `plugins` array, and spreads the routes into `fastifyPlugin({ routes: [...] })`. The wiring is idempotent (re-running never duplicates) and best-effort — if `app.ts` is missing or does not match the expected shape, nothing is changed and manual instructions are printed. Pass `--no-register` to opt out. New exported `registerResourceInApp()` / `AppRegistration`.

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

### Patch Changes

- Updated dependencies
  - @basaltkit/cli@0.1.0
