# Machize

**The Laravel-grade toolkit for building SaaS on Node.js.** Batteries-included,
self-hosted, no vendor lock-in — tenancy, auth, billing, permissions, queues,
storage and audit, integrated end to end, with TypeScript inference from the
route to the client.

Built on Fastify, Prisma, PostgreSQL, Redis, MinIO, BullMQ and Zod.

> **Status: 0.1.0 — early preview.** The architecture is in place and every
> package is tested, but APIs may change before 1.0 and several stores ship
> in-memory. See [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) and the full
> design in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quick start

```bash
npx create-machize my-saas   # tenancy + auth by default
cd my-saas && pnpm install && pnpm dev
```

Flags: `--billing` (plans), `--ui` (React + shadcn frontend), `--cli` (the
`mach` generator entrypoint), `--install`, `--git`.

## Production-ready by default

Secure and observable out of the box — every piece is zero-dependency and opt-in
through the plugin lifecycle. See the [Going to Production](https://github.com/Zebedeu/machize/blob/main/apps/docs/guide/production.md) guide.

| Concern | How |
|---|---|
| Edge protection | `securityPlugin` — rate limiting, CORS, secure headers |
| Secrets | `secret()` env schema — fail-closed in production |
| Brute force | `@machize/auth` login lockout, on by default |
| Safe retries | `idempotencyPlugin` — `Idempotency-Key` for mutations |
| Health | `healthPlugin` — `/livez` liveness vs `/readyz` readiness |
| Metrics | `metricsPlugin` — Prometheus `/metrics`, auto-instrumented |
| API docs | `openapiPlugin` — OpenAPI 3.0 from your Zod schemas |
| Supply chain | CI `pnpm audit`, CodeQL, Dependabot, npm provenance |

## Packages

**Foundation**

| Package | Purpose |
|---|---|
| `@machize/core` | DI container, plugin lifecycle, AsyncLocalStorage context, hooks |
| `@machize/config` · `@machize/env` | Namespaced config and Zod-validated env |
| `@machize/events` | Typed domain event bus with wildcards |
| `@machize/logger` | Pino logger, auto-enriched with request/tenant context |

**Infrastructure**

| Package | Purpose |
|---|---|
| `@machize/fastify` | HTTP adapter — typed routes, enrichers, guards |
| `@machize/prisma` | Tenant-scoping client extension, per-tenant client pool |
| `@machize/cache` · `@machize/queue` · `@machize/scheduler` | Redis cache, BullMQ jobs, fluent cron |
| `@machize/storage` · `@machize/mailer` | S3/MinIO/local storage, typed mail |
| `@machize/cli` | The `mach` command framework |

**SaaS domain**

| Package | Purpose |
|---|---|
| `@machize/tenancy` | Multi-tenancy — resolvers, per-request context, hooks |
| `@machize/auth` | Password hashing, JWT with refresh rotation, sessions |
| `@machize/permissions` | Roles, wildcard permissions, policies, tenant scoping |
| `@machize/subscriptions` | Plans, trials, feature limits, gateway drivers, webhooks |
| `@machize/flags` | Feature flags — per-tenant/user targeting, deterministic rollouts |
| `@machize/webhooks` | Outbound webhooks — signed delivery, retries, per-tenant subscriptions |
| `@machize/audit` · `@machize/activity` · `@machize/notifications` | Audit trail, activity feed, multi-channel notifications |

**Developer experience & product**

| Package | Purpose |
|---|---|
| `create-machize` | Project scaffolder |
| `@machize/testing` | createTestApp, mail/queue fakes, time travel |
| `@machize/sdk` | Type-safe client inferred from Zod endpoints |
| `@machize/generator` | `mach make` code scaffolding |
| `@machize/admin` · `@machize/dashboard` | Headless admin + dashboard engines |
| `@machize/admin-react` | React binding (DataTable, ResourceForm, hooks) |

## Development

```bash
pnpm install
pnpm build       # turbo, topological
pnpm test        # 210 tests across 28 suites
pnpm typecheck
```

Monorepo layout: `packages/*` (publishable `@machize/*`), `apps/*` (the
`playground` reference app), `tooling/*` (shared config). Versioning is
locked across `@machize/*` via Changesets.

## License

MIT.
