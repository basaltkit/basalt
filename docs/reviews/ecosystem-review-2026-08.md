# BasaltKit Ecosystem Review — 2026-08

_Principal-architect first pass. **Report only** — no code was changed, nothing committed._
_Umbrella: Basalt 1.5. Scope: 85 packages under `packages/**`, `ARCHITECTURE.md`, `.github/workflows`._

## Executive summary

The ecosystem is in strong shape: a clean, **cycle-free** dependency DAG (verified
programmatically), a mature secure-by-default HTTP edge (`packages/http/src/security.ts`),
an exemplary dev-only AI boundary test (`packages/ai-mcp/test/boundary.test.ts`), and a
well-deduplicated MCP core (`@basaltkit/mcp` re-exports `@basaltkit/mcp-core` rather than
forking it). The container, `AsyncLocalStorage` context, and the neutral request pipeline
are lean and correct — no performance red flags surfaced.

The one systemic issue cuts across Architecture and Quality: **the adapter-agnostic tenet
is asserted but not enforced.** Ten runtime feature/UI packages import the _neutral_ route
contract through `@basaltkit/fastify` (which hard-depends on `fastify@5`), so every app —
even an Express or Hono one — pulls Fastify into its graph. And the shared test harness
(`@basaltkit/testing`) is Fastify-only, so feature suites never execute against Express or
Hono. The contract is centralized and neutral; only the _wiring_ and the _tests_ drifted
toward one adapter. Fixing both is low-risk, mostly non-breaking, and restores a load-bearing
promise. A handful of smaller leaks (`@basaltkit/prisma` → whole `@basaltkit/cli` graph via a
no-op helper) and residual defense-in-depth items round out the backlog.

## Findings by severity

- 🔴 Critical: 0
- 🟠 Important: 2
- 🟡 Recommended: 6
- 🟢 Nice to have: 1

---

## 1. Architecture

### 🟠 A1 — Runtime feature packages hard-depend on the Fastify adapter for the *neutral* route contract

- **Problem.** `route`, `BasaltRoute`, `RouteGuard`, `RequestEnricher` are defined in
  `@basaltkit/http` (`packages/http/src/route.ts`, exported from `packages/http/src/index.ts`).
  `@basaltkit/fastify` merely **re-exports** them (`packages/fastify/src/route.ts` — an 11-line
  back-compat shim whose own comment says "runs unchanged on Express and Hono too"). Yet these
  packages import that contract **from `@basaltkit/fastify`** and declare it as a dependency:
  `auth`, `teams`, `comments`, `permissions`, `subscriptions`, `files`, plus UI packages
  `teams-ui`, `billing-ui`, `api-keys-ui`, `audit-viewer` (10 total; verified by grep, e.g.
  `packages/auth/src/routes.ts:2`, `packages/files/src/*:3`, `packages/subscriptions/src/plugin.ts:3`).
  `@basaltkit/fastify` has a **hard `"fastify": "^5.12.1"` dependency** (`packages/fastify/package.json`).
- **Impact.** Any app using `@basaltkit/auth` (or any of the 10) transitively installs and
  loads `@basaltkit/fastify` + `fastify@5` **even when it runs on Express or Hono**. This is
  bundle/`node_modules` weight for unused code and — more importantly — a direct violation of
  the "features target the contract, never one adapter" tenet. `subscriptions` is the tell: it
  already imports `route` from `@basaltkit/http` for its routes _and_ redundantly imports the
  same names from `@basaltkit/fastify` in the same file.
- **Proposal.** Repoint those 10 imports to `@basaltkit/http`, and swap the
  `@basaltkit/fastify` dependency for `@basaltkit/http` in each `package.json`. The symbols are
  byte-identical re-exports, so behavior is unchanged.
- **Trade-offs.** Touches 10 packages' imports + manifests; mechanical, but each needs a
  changeset (patch — dependency-only). Keep the fastify re-export shim for external back-compat.
- **Compatibility / breaking-change risk.** **None** for consumers (public exports unchanged);
  internal dependency-graph change only. Safe, high-value.

### 🟡 A2 — `@basaltkit/prisma` (a runtime package) drags the entire `@basaltkit/cli` graph via a no-op helper

- **Problem.** `packages/prisma/src/migrate-command.ts:1` and `sync-command.ts:6` import
  `defineCommand` from `@basaltkit/cli`. `defineCommand` is a **pure identity function**
  (`packages/cli/src/command.ts`: `return command`). `@basaltkit/cli` exposes only its barrel
  (`exports: { ".": … }`, no lean subpath), so importing that identity helper eagerly loads the
  whole CLI module graph (`runner`, `dev`, `upgrade` with `MIGRATIONS`, `builtins`) into every
  production app that uses Prisma repositories. Same class as the leaky-barrel pattern that
  previously bit `ai`/`generator`.
- **Impact.** Runtime weight + conceptual coupling (a data-access package depends on the CLI).
  Modest — `@basaltkit/cli` only deps `core` — but it is the wrong direction.
- **Proposal.** Use the **structural command pattern** that `@basaltkit/tenancy` already
  demonstrates (`packages/tenancy/src/index.ts` `registerTenantCommands`): push plain objects
  into the `'commands'` metadata bucket and rely on the structural `CommandDefinition` _type_
  (type-only import, erased at build). Drop the `@basaltkit/cli` runtime dep from `prisma`.
  (Alternative, if a value helper is wanted: add a `@basaltkit/cli/define` subpath exporting
  only `defineCommand`.)
- **Trade-offs.** Small refactor of two command files; one changeset.
- **Compatibility / breaking-change risk.** None (public surface unchanged; internal dep drop).

### 🟡 A3 — No architectural boundary test guards the adapter-agnostic rule (that is why A1 drifted)

- **Problem.** `@basaltkit/ai-mcp` has an excellent transitive-import boundary test
  (`packages/ai-mcp/test/boundary.test.ts`) that walks the import graph and fails if forbidden
  packages appear. Nothing analogous protects the adapter-agnostic invariant, so A1 accumulated
  silently over time.
- **Impact.** Boundary erosion is invisible until someone audits manually (this review).
- **Proposal.** Add one repo-level test (mirroring the ai-mcp pattern) asserting that
  adapter-agnostic feature packages do **not** declare or import `@basaltkit/fastify`
  (allowlist the genuinely adapter-bound ones: `@basaltkit/testing`, the adapters themselves).
  Cheap, self-documenting, prevents regression of the A1 fix.
- **Trade-offs.** One test to maintain + an explicit allowlist.
- **Compatibility / breaking-change risk.** None (test-only).

**Positives worth preserving:** cycle-free DAG (verified); `core` is a clean dependency sink;
`mcp` re-exports `mcp-core` instead of duplicating protocol/server/stdio; tenancy's structural
command registration is the right template for A2.

---

## 2. Developer Experience

### 🟡 D1 — `npm create basalt <name>` does not install or start by default; first-run has a manual gap

- **Problem.** In `packages/create-app/src/cli.ts`, `--install` and `--git` default to `false`
  (`parseArgs`). A user running `npm create basalt myapp` gets a scaffold but must then
  discover and run install + a dev command themselves. The north-star metric is time from
  `npm create` → first running app.
- **Impact.** Adds manual steps to the first-run path; easy to stumble on package-manager
  choice. (Auth/tenancy default **on**, and the wizard is rich — good.)
- **Proposal.** After scaffolding, always print a copy-pasteable "Next steps" block (`cd`,
  install with the detected PM, run dev). Optionally default `--install` on for the interactive
  wizard path (keep it opt-in for CI/`--yes`).
- **Trade-offs.** None material; keep non-interactive/CI behavior unchanged.
- **Compatibility / breaking-change risk.** None (CLI UX only).

**Positive:** the scaffold's secret handling is secure-by-default — `env.ts` uses
`secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-please-change-me' })`
(`packages/create-app/src/templates.ts:132`), fail-closed in production with an
`openssl rand` hint in `.env.example`. Good.

_(DX inspected at the scaffolder/flags/template level; I did **not** execute an end-to-end
`create → install → boot` run — see Coverage & limits.)_

---

## 3. Performance

**No reproducible performance problem found — and I am not manufacturing one.** The hot paths
are lean:

- `packages/core/src/container.ts` — token resolution is a `Map` lookup with an O(depth)
  parent walk (`findBinding`); cycle detection is a linear scan over a normally-shallow
  `resolving` stack; graph recording is off unless `enableGraph()` is called (explicitly
  zero-overhead by default).
- `packages/core/src/context.ts` — textbook single `AsyncLocalStorage`; no per-request
  allocation beyond the context object.
- `packages/http/src/pipeline.ts` — neutral pipeline; enrichers/guards resolved from metadata
  buckets, not reflection.

**If perf is ever prioritized, these need a benchmark first (not assumptions):** container
resolution under deep singleton graphs at boot, per-request scope creation cost, and Zod
`safeParse` on large bodies (`parsePart` in `pipeline.ts`). Claiming a regression without a
profile would violate the method — flagged as "needs a benchmark," not as a finding.

---

## 4. Quality & Robustness

### 🟠 Q1 — Cross-adapter contract coverage gap: the shared harness is Fastify-only

- **Problem.** `@basaltkit/testing` is bound to Fastify: `packages/testing/src/app.ts` imports
  `FASTIFY` from `@basaltkit/fastify`, types `server` as `FastifyInstance`, and drives requests
  via fastify's `inject`. Consequently feature integration suites (`auth`, `teams`, `comments`,
  `permissions`, `subscriptions`, …) execute **only on Fastify**. Test-file references by
  adapter: Fastify 29, Express 2, Hono 2 — and the Express/Hono ones are the adapters' _own_
  smoke tests (`packages/express/tests/*`, `packages/hono/tests/*`), not feature contract runs.
- **Impact.** The pipeline is centralized in `@basaltkit/http`, but enricher ordering, guard
  short-circuiting, error→HTTP mapping, ETag/304, and the security pre-hook are only verified
  end-to-end on one adapter. A regression in the Express or Hono adapter's pipeline binding
  would not be caught. This is the quality half of the same drift as A1.
- **Proposal.** Make the harness adapter-parametrizable (`createTestApp({ adapter })`), then add
  a small **conformance suite** run via `describe.each(['fastify','express','hono'])` over the
  neutral contract behaviors. Start with the highest-value invariants (guards, enrichers, error
  mapping, security headers/rate-limit) rather than duplicating every feature test.
- **Trade-offs.** The harness must abstract fastify's `inject` behind a neutral inject/HTTP
  call; Express/Hono need an in-process request driver. Real work, but confined to `testing`.
- **Compatibility / breaking-change risk.** Additive to `@basaltkit/testing` (keep the current
  Fastify default signature); no consumer break.

### 🟡 Q2 — Container cycle detection is per-container; cross-scope cycles may be unverified

- **Problem.** In `packages/core/src/container.ts`, the `resolving` cycle-detection stack is an
  instance field. When resolution crosses container boundaries (a request scope resolving a
  parent-owned singleton whose factory resolves back into the scope), the parent and child each
  keep their own `resolving` stack, so a cycle spanning the two may not be detected the way an
  intra-container one is.
- **Impact.** Narrow edge case, but a genuine correctness question for a load-bearing primitive.
- **Proposal.** Add a focused test for a parent↔child resolution cycle. If it is _not_ caught,
  share the resolution stack across the scope chain (walk to the root recorder) rather than
  keying it per instance. Verify before changing — this is a test-first item.
- **Trade-offs.** Minimal; possibly a few lines in `build`/`get`.
- **Compatibility / breaking-change risk.** None (tightens an error path only).

---

## 5. Security

The prior audit's hardening is present and solid — treat these as **positives to preserve**,
per the "don't re-litigate closed items" guidance:

- Rate-limit key does **not** trust `X-Forwarded-For` (`clientIp` uses `request.ip`, fails
  closed to a shared bucket when unknown) — `packages/http/src/security.ts`.
- CORS refuses to reflect an arbitrary `Origin` **with credentials** (`resolveOrigin`).
- Secure response headers default-on (HSTS, `nosniff`, `X-Frame-Options: DENY`, a lock-down
  `DEFAULT_CSP`); per-route stricter rate limits via `meta.rateLimit`.
- The dev-only AI agent confines writes to the launch subtree with symlink-escape resolution
  (`packages/ai-mcp/src/safety.ts` — `resolveWriteRoot`, `assertConfined`).
- Scaffold secret is fail-closed in production (`secret()` in the generated `env.ts`).

### 🟡 S1 — Tenant data isolation is opt-in at the repository layer, with no framework guardrail

- **Problem.** Tenancy attaches the resolved tenant to the request context
  (`packages/tenancy/src/index.ts` — the `http:enrichers` entry sets `context.tenant`), but
  **filtering by tenant is entirely the driver/repository's responsibility.** Nothing in the
  framework asserts that a tenant-scoped query actually constrained by `tenant.id`. A repository
  that forgets the `where: { tenantId }` clause leaks cross-tenant data with no tripwire.
- **Impact.** This is by design (source-based tenancy), and it works when authors are careful —
  but the highest-severity SaaS failure mode (cross-tenant leakage) has no defense-in-depth.
- **Proposal (measured).** Provide an **opt-in** fail-closed helper for Prisma/SQLite repos —
  e.g. a `tenantScoped(ctx)` wrapper that throws if `context.tenant` is unset when a model is
  marked tenant-owned, and injects the filter. Ship it as a convenience + a documented pattern,
  **not** as mandatory query rewriting. See the "NOT recommended" note against going further.
- **Trade-offs.** New surface in the `-prisma`/`-sqlite` packages; must stay strictly opt-in so
  single-tenant apps pay nothing.
- **Compatibility / breaking-change risk.** Additive/opt-in; no break.

_(I did not deeply read the runtime MCP tool authorization path — see Coverage & limits.)_

---

## 6. AI & MCP boundaries

The three-layer separation is intact and, in places, exemplary:

- `@basaltkit/mcp-core` (zero deps) owns the wire protocol; `@basaltkit/mcp` (runtime) and
  `@basaltkit/ai-mcp` (dev bridge) both consume it — **no duplication** (`mcp/src/protocol.ts`
  is a 21-line re-export of `mcp-core`).
- `@basaltkit/ai-mcp` depends on **exactly** `@basaltkit/ai` + `@basaltkit/mcp-core`, enforced
  by `packages/ai-mcp/test/boundary.test.ts` (walks the transitive graph; forbids
  core/http/mcp/cli). This is the gold standard the rest of the repo should copy (see A3).

### 🟡 AI1 — `@basaltkit/ai`'s own barrel mixes framework-free surface with CLI wiring, and has no boundary test of its own

- **Problem.** `packages/ai/src/index.ts` exports both framework-free provider/context/schema
  types **and** `aiCommands` (`./commands.js`, which imports `@basaltkit/cli`). The clean split
  exists only via subpaths (`@basaltkit/ai/analysis`, `/workflows`, `/schema`) that ai-mcp's
  test relies on — but there is no test at the **`@basaltkit/ai`** level asserting those
  subpaths stay framework-free. Because `@basaltkit/ai` is dev-only, importing the barrel
  pulling `cli`+`generator` is _acceptable_, but the subpath discipline is currently only
  guarded transitively from ai-mcp.
- **Impact.** Low. A future edit could quietly make `@basaltkit/ai/analysis` pull the CLI and
  only ai-mcp's test would catch it (indirectly).
- **Proposal.** Add a small boundary test in `@basaltkit/ai` asserting `/analysis`, `/workflows`,
  `/schema` do not import `@basaltkit/cli`. Mirrors A3/ai-mcp.
- **Trade-offs.** One test.
- **Compatibility / breaking-change risk.** None (test-only).

---

## Deliberately NOT recommended (over-engineering)

- **Decorator/reflection-metadata DI.** Violates a core tenet; the explicit `Container`/`Token`
  wiring is a feature, not a gap. No.
- **Mandatory tenant-aware query-rewriting layer.** Intercepting every query to force
  `tenantId` would be invasive, adapter-specific, and surprising for single-tenant apps. Keep
  S1 strictly opt-in; do not build a global ORM interceptor.
- **Extracting the route contract into its own micro-package** (`@basaltkit/route`). Unnecessary
  — `@basaltkit/http` is already the neutral home; A1 is solved by importing from it, not by
  minting another package.
- **Per-adapter forks of feature code.** The neutral pipeline is the whole point; do not copy
  handlers per adapter. Q1 is solved by testing the one contract across three adapters, not by
  three implementations.
- **A separate lean `@basaltkit/cli-types` package for `defineCommand`.** A2's structural
  pattern (already used by tenancy) is simpler than a new package or even a new subpath.

## Coverage & limits (what I did NOT deeply inspect)

- **End-to-end DX run.** I read `create-app`'s CLI, wizard, and templates but did **not** time
  or execute a real `create → install → boot → first request` cycle. D1 is from the scaffolder
  code, not a stopwatch.
- **Runtime MCP tool authorization.** I confirmed the mcp/mcp-core structure and the dev-side
  `ai-mcp` confinement, but did **not** trace `packages/mcp/src/tools.ts` to confirm runtime MCP
  tools enforce per-request tenancy/permissions on every tool call. Recommend a dedicated pass
  (potential S-level item).
- **Data drivers breadth.** I read `tenancy` and sampled the command/coupling pattern in
  `prisma`, but did **not** audit each `-prisma`/`-sqlite`/`-postgres`/queue/storage/search
  driver for tenant scoping or failure modes. S1 generalizes a risk; per-driver verification is
  outstanding.
- **Payments drivers** (`subscriptions-appypay`/`-proxypay`) — known unpublished skeletons,
  intentionally skipped.
- **Benchmarks.** No profiling was run; all Performance notes are explicitly "needs a
  benchmark," never asserted regressions.
- **Depth.** ~20 of 85 packages were read closely (core, http, fastify, the MCP/AI trio,
  tenancy, testing, create-app, cli, prisma); the rest were assessed via the dependency graph
  and barrels. Findings are ranked by value, not exhaustiveness.
