<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/basalt-logo-dark.svg">
    <img alt="Basalt" src="brand/basalt-logo.svg" width="360">
  </picture>
</p>

**The modular backend framework for Node.js — with the SaaS batteries included.**
A DI container, a plugin lifecycle and a framework-neutral HTTP core, plus
opt-in building blocks: auth, queues, storage, cache, search, realtime, audit —
and, when you need them, tenancy, teams and billing. Self-hosted, no vendor
lock-in, TypeScript inference from the route to the client.

Runs on **Fastify, Express or Hono** (swap adapters without touching your
routes), with Prisma, PostgreSQL, Redis, MinIO, BullMQ and Zod.

> **Status: Basalt 1.6 — the release where the framework guarantees what it
> promises. 84 packages, each versioned independently. 🎉** Three architecture
> review cycles turned the project's promises into machine-enforced rules:
> adapter neutrality, the dev-only AI boundary, "a generic package never
> requires tenancy", DI lifetime safety and boot-time fail-loud for declared
> guards are now **CI tripwires**, not conventions. The public API is stable and
> covered by [semantic versioning](https://basaltkit-docs.pages.dev/guide/versioning):
> breaking changes only in a new major, features in a minor, fixes in a patch.
> In-memory stores are the dev default; every stateful domain has a durable
> backend — auth, teams, subscriptions, permissions, comments, audit, activity
> and notifications persist via SQLite (`*-sqlite`, single-node, zero-dep) or
> Prisma (`*-prisma`, Postgres/MySQL). See
> [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) and the full design in
> [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quick start

```bash
npx create-basalt my-app    # installs and git-inits by default (interactive)
cd my-app && pnpm dev
```

| Flag | What it adds |
|---|---|
| `--billing` | subscription plans + billing routes |
| `--ui` | React + shadcn frontend |
| `--cli` | the `basalt` generator entrypoint |
| `--mcp` | MCP server (expose routes as agent tools) + the dev-only AI bridge |
| `--no-tenancy` / `--no-auth` | leave the SaaS/auth layers out — see [Beyond SaaS](https://basaltkit-docs.pages.dev/guide/beyond-saas) |
| `--no-install` / `--no-git` | skip the defaults (they're off in CI/non-TTY anyway) |
| `--yes` | accept every default, no prompts |

## Production-ready by default

Secure and observable out of the box — every piece is zero-dependency and opt-in
through the plugin lifecycle. See the [Going to Production](https://github.com/basaltkit/basalt/blob/main/apps/docs/guide/production.md) guide.

| Concern | How |
|---|---|
| Edge protection | `securityPlugin` — rate limiting, CORS, secure headers |
| Secrets | `secret()` env schema — fail-closed in production |
| Brute force | `@basaltkit/auth` login lockout, on by default |
| Safe retries | `idempotencyPlugin` — `Idempotency-Key` for mutations |
| Health | `healthPlugin` — `/livez` liveness vs `/readyz` readiness |
| Metrics | `metricsPlugin` — Prometheus `/metrics`, auto-instrumented |
| Tracing | `tracingPlugin` — W3C trace-context, OTLP export (no OTel SDK) |
| API docs | `openapiPlugin` — OpenAPI 3.0 from your Zod schemas |
| Reliable delivery | `outboxPlugin` (at-least-once) + `webhooksPlugin` (signed) |
| Quality gates | Coverage thresholds, `pnpm audit`, CodeQL, secret scanning ([lint is paused](https://basaltkit-docs.pages.dev/guide/versioning) until `typescript-eslint` supports TS 7) |
| Architecture gates | CI tripwires: adapter neutrality, dev-only AI boundary, no-tenancy-in-generic-packages, DI lifetime safety, cross-adapter conformance |
| Supply chain | Dependabot, npm provenance, independent per-package versioning |

## Packages

`@basaltkit/*` is a **general-purpose backend framework** — most packages (HTTP,
cache, queue, storage, mailer, events, …) work in any Node app. The
**SaaS-specific** building blocks (tenancy, auth, permissions, subscriptions,
audit/activity/notifications) are grouped under *SaaS domain* below and carry
the `saas` keyword on npm.

**Foundation**

| Package | Purpose |
|---|---|
| `@basaltkit/core` | DI container, plugin lifecycle, AsyncLocalStorage context, hooks |
| `@basaltkit/config` · `@basaltkit/env` | Namespaced config and Zod-validated env |
| `@basaltkit/events` | Typed domain event bus with wildcards |
| `@basaltkit/logger` | Pino logger, auto-enriched with request/tenant context |

**Infrastructure**

| Package | Purpose |
|---|---|
| `@basaltkit/http` | Framework-neutral HTTP core — typed routes, pipeline, error mapping |
| `@basaltkit/fastify` · `@basaltkit/express` · `@basaltkit/hono` | HTTP adapters — the same routes run on any of them |
| `@basaltkit/prisma` | Tenant-scoping client extension, per-tenant client pool |
| `@basaltkit/cache` · `@basaltkit/queue` · `@basaltkit/scheduler` | Redis cache, BullMQ jobs (pluggable driver + capability checks), fluent cron |
| `@basaltkit/cache-tiered` | Multi-level cache driver for `@basaltkit/cache` — in-process near cache in front of Redis, zero deps |
| `@basaltkit/queue-rabbitmq` | RabbitMQ driver for `@basaltkit/queue` — AMQP jobs with retries, backoff, delay, priority |
| `@basaltkit/queue-kafka` | Kafka driver for `@basaltkit/queue` — produce/consume with retry + dead-letter topics |
| `@basaltkit/queue-sqs` | Amazon SQS driver for `@basaltkit/queue` — native delay, retries with backoff, dead-letter queue |
| `@basaltkit/storage` · `@basaltkit/mailer` | S3/MinIO/local storage, typed mail |
| `@basaltkit/cli` | The `basalt` command framework |

**SaaS domain**

| Package | Purpose |
|---|---|
| `@basaltkit/tenancy` | Multi-tenancy — resolvers, per-request context, hooks |
| `@basaltkit/auth` | Password hashing, JWT with refresh rotation, sessions, email verification, password reset, API keys, MFA (TOTP) |
| `@basaltkit/permissions` | Roles, wildcard permissions, policies, tenant scoping |
| `@basaltkit/teams` | Multi-user tenants — roles, email invitations, membership management, `teamRole` guard |
| `@basaltkit/subscriptions` | Plans, trials, feature limits, gateway drivers, webhooks, hosted Checkout & Customer Portal, proration |
| `@basaltkit/flags` | Feature flags — per-tenant/user targeting, deterministic rollouts |
| `@basaltkit/webhooks` | Outbound webhooks — signed delivery, retries, per-tenant subscriptions |
| `@basaltkit/audit` · `@basaltkit/activity` · `@basaltkit/notifications` | Audit trail, activity feed, multi-channel notifications |
| `@basaltkit/realtime` | Server→client push (WebSocket/SSE), per-tenant channels, presence, events bridge, Redis backplane |
| `@basaltkit/realtime-client` | Browser client for `@basaltkit/realtime` — subscribe channels over WS/SSE, auto-reconnect, zero deps |
| `@basaltkit/search` | Tenant-scoped full-text search — in-memory (dev) & Meilisearch (prod) drivers, auto-sync from events |
| `@basaltkit/search-postgres` | PostgreSQL full-text driver for `@basaltkit/search` — tsvector/tsquery/ts_rank, tenant-scoped |
| `@basaltkit/storage-gcs` · `@basaltkit/storage-azure` | Google Cloud Storage & Azure Blob drivers for `@basaltkit/storage` |
| `@basaltkit/files` | Upload pipeline over storage — type/size validation, per-tenant quota, metadata, signed URLs, scan hooks |
| `@basaltkit/comments` | Per-resource comment threads — @mentions, resolve/reopen, tenant-scoped, events for realtime & notifications |
| `@basaltkit/i18n` | Internationalization — context-resolved locale, typed catalogs with plurals, Intl formatting, zero deps |
| `@basaltkit/exports` | Data exports — typed definitions → CSV/TSV/JSON/NDJSON, pluggable formatters, async via queue |
| `@basaltkit/exports-xlsx` | XLSX formatter for `@basaltkit/exports` — a valid .xlsx with a built-in ZIP writer, zero deps |
| `@basaltkit/audit-viewer` | Read-only audit-trail browser — tenant-scoped filters, pagination, stats, self-contained HTML page |
| `@basaltkit/api-keys-ui` | Self-contained page to create/list/revoke `@basaltkit/auth` API keys — zero deps, no build |
| `@basaltkit/teams-ui` | Self-contained page to manage `@basaltkit/teams` — invitations & members, zero deps, no build |
| `@basaltkit/billing-ui` | Self-contained subscription page for `@basaltkit/subscriptions` — plans, Checkout, Customer Portal |

**Developer experience & product**

| Package | Purpose |
|---|---|
| `create-basalt` | Project scaffolder |
| `@basaltkit/testing` | createTestApp, mail/queue fakes, time travel |
| `@basaltkit/sdk` | Type-safe client inferred from Zod endpoints |
| `@basaltkit/generator` | `basalt make` code scaffolding |
| `@basaltkit/admin` · `@basaltkit/dashboard` | Headless admin + dashboard engines |
| `@basaltkit/admin-react` | React binding (DataTable, ResourceForm, hooks) |

## Development

```bash
pnpm install
pnpm build       # turbo, topological
pnpm test        # 1837 tests across 244 files
pnpm typecheck
```

Monorepo layout: `packages/*` (the publishable `@basaltkit/*`), `tooling/*`
(shared config) and `apps/*` — `playground` (reference app), `docs` (the
VitePress site), `beyond-saas` (the no-tenancy guarantee, exercised as a real
app), `pg-integration` (tests against a real PostgreSQL), `bench` and
`admin-demo`. Each `@basaltkit/*` package is versioned independently (changesets
capture changelogs).

## License

MIT.
