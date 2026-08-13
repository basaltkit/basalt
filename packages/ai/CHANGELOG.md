# @basaltkit/ai

## 0.2.0

### Minor Changes

- **`ai:make` generation quality — 5 fixes surfaced by validating real modules.**

  1. **Tenant-scoped repositories now scope `tenantId` explicitly** from the
     request context (`renderPrismaRepository`) instead of relying on a global
     `tenancyExtension`. Works on a raw Prisma client shared with non-tenant
     models (e.g. auth) — previously `create` threw *"Argument tenantId is
     missing"* (a 500) on the first tenant-scoped model.
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
