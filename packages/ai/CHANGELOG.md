# @basaltkit/ai

## 1.2.0

### Minor Changes

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

- Updated dependencies [36ab1a1]
  - @basaltkit/generator@1.3.0

## 1.1.3

### Patch Changes

- 4586ff4: Detect the per-backend queue plugins (`bullmqQueuePlugin`,
  `rabbitmqQueuePlugin`, `sqsQueuePlugin`, `kafkaQueuePlugin`) as evidence of the
  `queue` capability.
  
  Stack detection prefers the plugins actually wired in `app.ts`, and matched only
  the core `queuePlugin` — so from now on it would have reported "no queue" for
  every app that picked a real backend.

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/cli@1.2.3
  - @basaltkit/generator@1.2.2

## 1.1.1

### Patch Changes

- 59cf29c: Read `--no-register` / `--no-migrate` through the CLI's new flag negation.
  
  `@basaltkit/cli`'s `parseArgv` now parses a bare `--no-<name>` as `<name>: false`. These commands checked the literal `flags['no-register']` / `flags['no-migrate']` key, which that change would have made permanently absent — silently re-enabling the very behavior the flag suppresses. Both now check the negated form, and still accept the legacy literal key for programmatic callers.
- Updated dependencies [59cf29c]
- Updated dependencies [59cf29c]
  - @basaltkit/cli@1.2.2
  - @basaltkit/generator@1.2.1

## 1.1.0

### Minor Changes

- 552cbe8: AI MCP bridge — M2 (provider workflows), RFC 0001 §E / §D.1(2).
  
  - **`@basaltkit/ai`** threads streaming, progress and cancellation through the workflow engine:
    - `GenerateOptions` gains `signal?: AbortSignal`, forwarded into each provider's fetch (Anthropic/Ollama/OpenAI-compatible) and honoured by `fetchWithRetry` (a cancelled request fails immediately, never retried).
    - `createPlan` and `reviewImplementation` (and `runMake`, for consistency) accept `{ signal?, onProgress? }`. With `onProgress`, generation streams via `provider.stream` and emits each fragment; without it, the one-shot `generate` path is unchanged. Cancellation is raced at the workflow layer so it's prompt even if a provider ignores the signal. New exports: `runGeneration`, `generateText`, `withAbort`, `throwIfAborted`, `abortError`, `isAbortError`, and the `WorkflowProgress` / `OnProgress` / `WorkflowRunOptions` types.
    - New `providerEnvFrom(env)` (the env-record form of `providerEnvFromProcess`).
    - New framework-free **`@basaltkit/ai/workflows`** subpath exposing `createProvider`, `providerEnvFrom(FromProcess)`, `createPlan`, `reviewImplementation` (+ types) **without** the `basalt ai` CLI wiring — so dev-only, out-of-process consumers use them without pulling `@basaltkit/core`/`http` into their graph.
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains the two provider-backed tools: `basalt_plan` (natural language → `ArchitecturePlan`) and `basalt_review` (LLM critique → verdict). Both stream MCP `notifications/progress` and honour `notifications/cancelled` via the tool context's `signal`. Provider config is read from the client-supplied `env` and used only in-memory — never logged or persisted. Still boundary-clean: only `@basaltkit/ai` + `@basaltkit/mcp-core`.
- 552cbe8: AI MCP bridge — M1 (read-only), RFC 0001 §E.
  
  - **New `@basaltkit/ai-mcp`** (dev-only, debuts at 0.1.0): a Model Context Protocol server that exposes Basalt's AI developer workflows to MCP clients (Claude Desktop/Code) over stdio, via the `basalt-ai-mcp` bin. M1 is read-only — no AI provider, no file writes:
    - Tools: `basalt_analyze` (stack, data model, diagnostics) and `basalt_doctor` (diagnostics + in-memory auto-fix previews).
    - Resources: `basalt://project/{context,analysis,diagnostics}` and `basalt://knowledge/architecture`.
    - Depends only on `@basaltkit/ai` + `@basaltkit/mcp-core`; it never pulls the framework runtime (`@basaltkit/core`/`http`) or the runtime `@basaltkit/mcp` into its graph (enforced by a boundary test).
  - **`@basaltkit/ai`** gains a framework-free `@basaltkit/ai/analysis` subpath that re-exports the read-only surface (`detectProject`, `analyze`, `runDoctor`, `planFix`, `BASALT_KNOWLEDGE`, …) **without** the `basalt ai` CLI wiring. The main barrel re-exports `aiCommands`, which imports `@basaltkit/cli` → `@basaltkit/core`; the new subpath lets dev-only, out-of-process consumers use analyze/doctor without dragging the framework runtime into their dependency graph.
- 552cbe8: AI MCP bridge — M3 (safe make), RFC 0001 §E / §D.1(3).
  
  - **`@basaltkit/ai`** adds a safe-preview to `runMake`: a dry-run now stats every target and returns `MakeResult.preview.perFile[]` (`{ path, action: 'create' | 'overwrite', diff }`) with unified diffs, plus `preview.clashes`. The preview writes nothing; `prisma db push`/`migrate` stays strictly opt-in. New `FilePreview`/`MakePreview` types and a dependency-free unified-diff generator. `runMake` (and its make types) are now reachable from the framework-free `@basaltkit/ai/workflows` subpath.
  - **`@basaltkit/generator`** adds a framework-free **`@basaltkit/generator/resource`** subpath exposing `generateResource`/`writeGenerated`/`registerResourceInApp`/`names`/`FileExistsError` (+ types) **without** `generatorCommands` — which imports `@basaltkit/cli` (→ `@basaltkit/core`). `@basaltkit/ai`'s make engine now imports this subpath, so `runMake` no longer pulls the framework runtime, and dev-only consumers stay boundary-clean.
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains the `basalt_make` tool with a safety layer (`src/safety.ts`): **preview is the default and writes nothing**; `mode:'apply'` is explicit and refuses to overwrite a clash unless `force:true`; `prisma db push` runs only when `migrate:true` (double-gated); all writes are **confined to the launch workspace** (rejects `../` traversal, absolute paths, and symlink escapes before any write); an `apply` is confirmed via MCP elicitation when the client supports it, with the explicit preview→apply two-call flow as the floor. Plan↔make correlation is stateless — the client carries the full `ArchitecturePlan`. Progress via `ctx.progress`, cancellation via `ctx.signal`.
- 552cbe8: MCP foundations (RFC 0001 M0): extract a zero-dependency `@basaltkit/mcp-core` and grow the AI data contracts.
  
  - **New `@basaltkit/mcp-core`** (zero runtime dependencies): the JSON-RPC 2.0 + MCP wire protocol, a transport-neutral `McpServer` that dispatches over function-shaped tools/resources/prompts (with `AbortSignal` cancellation and progress plumbing), and a stdio transport. This is the shared wire that lets the runtime MCP surface and the forthcoming dev-only AI bridge reuse one protocol implementation without dragging the framework runtime into a developer's toolchain.
  - **`@basaltkit/mcp`** now builds its route-tools on top of `@basaltkit/mcp-core`. Public API and behaviour are unchanged (patch); the wire dispatch is delegated to the shared core.
  - **`@basaltkit/ai`** exports runtime `zod` schemas and a `toJsonSchema()` for its public data contracts (`ArchitecturePlan`, `MakeResult`, `AnalysisReport`, `ProjectContext`, `AgentReview`) — also available at the `@basaltkit/ai/schema` subpath. `parsePlan`/`parseReview` now validate their coerced output against these schemas, and `ArchitecturePlan`/`MakeResult` carry a `schemaVersion` for cross-process round-trips. Adds `zod` as a dependency of this dev-only package.

### Patch Changes

- Updated dependencies [552cbe8]
  - @basaltkit/generator@1.2.0

## 0.11.0

### Minor Changes

- 9f606fa: Security P2 — institutionalize:

  - **`@basaltkit/tenancy` (fix):** `normalizeDomain` now strips _all_ trailing dots,
    not just one — `example.com..` normalized to `example.com.` (non-idempotent),
    which could sidestep the custom-domain dedup/lookup. Found by a new property/fuzz
    test. Now idempotent and canonical for every input.
  - **`@basaltkit/ai`:** new `ai:doctor` security rule **`in-memory-security-store`** —
    warns when WebAuthn passkeys/challenges, roles & permissions, or verified custom
    domains are kept in an in-memory store (lost on restart, not shared across
    instances → lockouts or authorization drift in production).

  Also adds parser property/fuzz tests (SSE encoder injection-resistance, domain
  normalization totality/idempotence, TOTP roundtrip) that run in CI on every change.

## 0.10.0

### Minor Changes

- Add two `ai:doctor` security rules — `missing-tenant-membership` (error) and `missing-security-plugin` (warning) — as a continuous custodian for the tenant-isolation invariants.

## 0.9.2

### Patch Changes

- **A tenant-scoped repository now returns a clear 400 when there is no tenant in context**, instead of a generic 500. The generated `currentTenantId()` throws `HttpError(400, TENANT_REQUIRED, "send the x-tenant-id header …")` — a missing/unresolved tenant is a client error, and the old silent 500 hid the real cause.

## 0.9.1

### Patch Changes

- **ai:make now offers to run `prisma db push` right after generating.** The most-forgotten step: without it the Prisma client has no delegate for the new model, so every route 500s (list + create). ai:make now prompts to run db push immediately (skip with `--no-migrate`, auto-run with `--migrate` or `--yes`). After it runs, restart the dev server to load the regenerated client.

## 0.9.0

### Minor Changes

- **Enum field support (Fase 12).** A plan field can now carry `enum: string[]` — it becomes a validated `z.enum([...])` in the Zod schema (entity + create), a `String` column in Prisma (no native enum block / migration churn), and the repository mapper narrows the row value to the union. The Architect prompt recognises a fixed set of values (e.g. "estado (pago/pendente)") and emits the enum instead of a free `z.string()`. Found via a live Review-agent suggestion.

## 0.8.1

### Patch Changes

- **Review agent scope fix.** The `--review` agent could raise a _blocking_ `fit`
  error when the request asked for something outside `ai:make`'s scope (e.g. "web
  interfaces"), even though the generated backend was correct — found in a live
  run. The rubric now states `ai:make` produces a backend resource vertical only;
  out-of-scope requests (web UI, frontend, jobs) are a `warning` at most, never an
  `error`. The `fit` dimension judges the backend against the request's data model.

## 0.8.0

### Minor Changes

- **OpenAPI enrichment (Fase 11, spec §14).** `ai:make` now adds a `summary` and
  `tags` to every generated route's `meta` (merging with the RBAC `can` guard) —
  `List clientes`, `Create a cliente`, `Get a cliente`, … tagged by the resource.
  Paired with `@basaltkit/http@1.1.0` (which renders summary/description/tags/
  operationId + human status descriptions), the generated OpenAPI is grouped by
  resource and readable instead of a flat, undescribed list. Requires
  `@basaltkit/http` ≥ 1.1.0 in the app for the metadata to surface.

## 0.7.0

### Minor Changes

- **Review agent (Fase 10, spec §19/§20).** `ai:make --review` runs an LLM pass
  over the _generated code_ (model, schema, routes, service, repository,
  permissions) plus the deterministic review, and returns a verdict with issues by
  dimension (tenancy, security, rbac, validation, audit, tests, fit). `approved` is
  **derived from the issues** — any error-severity issue blocks (and makes the
  command exit non-zero), warnings don't. Reuses the same provider as planning; a
  review error is reported but never fails the build. Read-only — it judges, it
  doesn't edit. `reviewImplementation` / `parseReview` are exported and
  provider-injectable for testing.

## 0.6.0

### Minor Changes

- **`ai:make` auto-merges models into `prisma/schema.prisma` (Fase 9).** The
  generator emits each model as a snippet and, until now, left "copy it into
  schema.prisma, run db push, restart" as a manual step — the biggest recurring
  friction. `ai:make` now appends the generated model block(s) to the schema
  (idempotent — skips models already present) and reports it. `--migrate` runs
  `npx prisma db push` afterward (creates the table(s) + regenerates the client);
  without it, the follow-up and review point at the command. The review's
  Migration item reflects the actual state (merged / pushed / failed).

## 0.5.0

### Minor Changes

- **`basalt ai:fix` (Fase 8) — closes the analyze → doctor → fix loop.** The doctor
  only printed advice; now `ai:fix <id>` (or `ai:fix` for every currently-firing
  auto-fixable rule) applies the change to the right file, with a line-level diff,
  a confirmation prompt, `--dry-run` and `--yes`. Auto-fixers ship for the safe,
  precise rules — `fastify-logger-off` (adds the Fastify logger option) and
  `insecure-app-secret` (drops the committed default, sets `min(32)`). Rules that
  need a judgement call (tenant scoping, durable stores) report "no auto-fix —
  apply manually".

## 0.4.0

### Minor Changes

- **Permission registration (Fase 7) — closes the RBAC loop.** F4 injected route
  `meta.can` guards but left granting the permissions as a manual to-do. `ai:make`
  now emits a `<kebab>.permissions.ts` per guarded resource: a
  `<NAME>_PERMISSIONS` constant (the exact `<plural>.<action>` strings the routes
  guard on) plus a `grant<Name>Permissions(store, role, scope?)` helper over
  `@basaltkit/permissions`. The review reflects it and the follow-up points at the
  helper, so registering RBAC is one call in the app's seed/setup.

## 0.3.0

### Minor Changes

- **Real Prisma relations (Fase 6).** A plan entity's `relations` are now
  generated as proper Prisma relations, not bare `String` FK columns. A belongs-to
  relation (`{ name, model }`) emits: the `<name>Id` FK column, a
  `<name> <Model> @relation(fields: [<name>Id], references: [id])` field, and — on
  the related model, when it's in the same plan — the inverse `<plural> <This>[]`
  field. The FK is also a validated field in the Zod schema and the repository
  mapper. Output verified with `prisma validate`.

  `PlanEntity.relations` is now `{ name, model }[]` (bare model-name strings are
  still accepted and normalized). Relations to a model outside the plan are
  surfaced as a follow-up to add the inverse field manually.

## 0.2.1

### Patch Changes

- **`DateTime` create/update fields now coerce to a `Date`** (`z.coerce.date()`)
  instead of a bare `z.string()`. A plain string let a non-ISO value like
  `"1990-05-01"` through to Prisma, which requires ISO-8601 and threw a 500. Now a
  date-only or ISO string is accepted (and coerced), while garbage is rejected
  with a 400 at the Zod layer. Output stays an ISO string (unchanged). Found while
  route-testing a generated module end to end.

## 0.2.0

### Minor Changes

- **`ai:make` generation quality — 5 fixes surfaced by validating real modules.**

  1. **Tenant-scoped repositories now scope `tenantId` explicitly** from the
     request context (`renderPrismaRepository`) instead of relying on a global
     `tenancyExtension`. Works on a raw Prisma client shared with non-tenant
     models (e.g. auth) — previously `create` threw _"Argument tenantId is
     missing"_ (a 500) on the first tenant-scoped model.
  2. **The repository mapper now maps every domain field** (with `DateTime →
ISO string`), not just id/name/timestamps — responses were dropping domain
     fields before.
  3. **Follow-up + review text says `npx prisma db push`** (or `prisma migrate
dev`), not `basalt prisma:sync` (which only merges `@basaltkit/*-prisma`
     package models and doesn't regenerate the client).
  4. **The generator's base `name` column is dropped** when the entity supplies
     its own fields and none is literally `name` (no more `name` + `nome`).
  5. **Permission guards use a per-entity namespace** (`names(entity).pluralKebab`)
     so each entity in a multi-entity plan is guarded by its own permission, not
     one shared prefix taken from `permissions[0]`.

  Relations are still generated as foreign-key `String` columns; a follow-up now
  says so and points at Prisma `@relation` for referential integrity.

## 0.1.0

### Minor Changes

- **Foundation release of the AI-native developer experience.**

  - **Provider abstraction** (`AIProvider`) — vendor-agnostic AI surface selected
    by `AI_PROVIDER`. Ships **Anthropic** (default) and **Ollama** (local, no key)
    providers over REST directly (no SDK), with an injectable `fetch` for testing.
    OpenAI/Google/OpenAI-compatible throw a clear "not yet implemented" error.
  - **Project context detection** (`detectProject`) — statically detects the wired
    stack (Fastify, Prisma, database, tenancy, auth, RBAC, subscriptions, payments,
    queue, search, audit, events, scheduler…), the Prisma data model with
    tenant-scoping, and key config signals. Reader is injectable for tests.
  - **`basalt ai:analyze`** — read-only analysis report (`✓ … detected`, data
    model, diagnostics summary).
  - **`basalt ai:doctor`** — read-only diagnostics engine with six built-in rules
    (insecure `APP_SECRET`, lazy Prisma boot, Fastify logger off, missing tenant
    scoping, in-memory sources, localhost Redis default). Exits non-zero on errors
    so CI can gate on it.
  - **`basalt ai:plan`** — natural language → structured `ArchitecturePlan`
    (read-only). The Architect prompt encodes Basalt's official APIs, so plans
    reuse `make:resource`, tenant scoping, RBAC permissions and audit events
    instead of inventing abstractions. Compact project context keeps prompts small
    and grounded.
  - **`basalt ai:make`** — execute a plan: scaffold each entity via the official
    `@basaltkit/generator`, inject the plan's domain fields into the Prisma model
    (+ `tenantId`/`@@index` when tenant-scoped) and the Zod schema, **auto-wire RBAC
    permission guards** (route `meta.can`) and **audit recording** (`AUDIT.record()`
    in the service, `AUDIT` injected via the plugin) when those plugins are enabled,
    write + wire into `src/app.ts`, then run a deterministic **review gate** (tenant
    isolation, validation/routes, tests, permissions, audit). Migration stays a
    manual follow-up (the generator emits a schema snippet). Safe by default:
    `--dry-run`, confirmation before writes, no destructive operations, optional
    `--verify` typecheck.
