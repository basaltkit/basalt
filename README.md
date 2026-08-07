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
| Tracing | `tracingPlugin` — W3C trace-context, OTLP export (no OTel SDK) |
| API docs | `openapiPlugin` — OpenAPI 3.0 from your Zod schemas |
| Reliable delivery | `outboxPlugin` (at-least-once) + `webhooksPlugin` (signed) |
| Quality gates | CI lint (ESLint), coverage thresholds, `pnpm audit`, CodeQL |
| Supply chain | Dependabot, npm provenance, lockstep versioning |

## Packages

`@machize/*` is a **general-purpose backend toolkit** — most packages (HTTP,
cache, queue, storage, mailer, events, …) work in any Node app. The
**SaaS-specific** building blocks (tenancy, auth, permissions, subscriptions,
audit/activity/notifications) are grouped under *SaaS domain* below and carry
the `saas` keyword on npm.

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
| `@machize/http` | Framework-neutral HTTP core — typed routes, pipeline, error mapping |
| `@machize/fastify` · `@machize/express` · `@machize/hono` | HTTP adapters — the same routes run on any of them |
| `@machize/prisma` | Tenant-scoping client extension, per-tenant client pool |
| `@machize/cache` · `@machize/queue` · `@machize/scheduler` | Redis cache, BullMQ jobs (pluggable driver + capability checks), fluent cron |
| `@machize/queue-rabbitmq` | RabbitMQ driver for `@machize/queue` — AMQP jobs with retries, backoff, delay, priority |
| `@machize/queue-kafka` | Kafka driver for `@machize/queue` — produce/consume with retry + dead-letter topics |
| `@machize/queue-sqs` | Amazon SQS driver for `@machize/queue` — native delay, retries with backoff, dead-letter queue |
| `@machize/storage` · `@machize/mailer` | S3/MinIO/local storage, typed mail |
| `@machize/cli` | The `mach` command framework |

**SaaS domain**

| Package | Purpose |
|---|---|
| `@machize/tenancy` | Multi-tenancy — resolvers, per-request context, hooks |
| `@machize/auth` | Password hashing, JWT with refresh rotation, sessions, email verification, password reset, API keys, MFA (TOTP) |
| `@machize/permissions` | Roles, wildcard permissions, policies, tenant scoping |
| `@machize/teams` | Multi-user tenants — roles, email invitations, membership management, `teamRole` guard |
| `@machize/subscriptions` | Plans, trials, feature limits, gateway drivers, webhooks, hosted Checkout & Customer Portal, proration |
| `@machize/flags` | Feature flags — per-tenant/user targeting, deterministic rollouts |
| `@machize/webhooks` | Outbound webhooks — signed delivery, retries, per-tenant subscriptions |
| `@machize/audit` · `@machize/activity` · `@machize/notifications` | Audit trail, activity feed, multi-channel notifications |
| `@machize/realtime` | Server→client push (WebSocket/SSE), per-tenant channels, presence, events bridge, Redis backplane |
| `@machize/realtime-client` | Browser client for `@machize/realtime` — subscribe channels over WS/SSE, auto-reconnect, zero deps |
| `@machize/search` | Tenant-scoped full-text search — in-memory (dev) & Meilisearch (prod) drivers, auto-sync from events |

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
