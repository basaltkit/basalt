# Packages

Basalt is a set of small, focused packages under the `@basaltkit/*` scope. Each
works on its own; together they form the framework. Each package is versioned independently — see the [Ecosystem](../guide/ecosystem) page for every package's current version.

## Foundation

| Package | Purpose |
|---|---|
| `@basaltkit/core` | DI container, plugin lifecycle, `AsyncLocalStorage` context, hooks |
| `@basaltkit/config` | Namespaced, typed configuration with dot-path access |
| `@basaltkit/env` | Zod-validated environment variables with an aggregated report |
| `@basaltkit/events` | Typed domain event bus with wildcards and priorities; transactional outbox |
| `@basaltkit/events-sqlite` · `@basaltkit/events-prisma` | Durable backends for the `@basaltkit/events` OutboxStore — crash-safe transactional outbox; SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/logger` | Pino logger, auto-enriched with request/tenant context, redaction |

## HTTP

| Package | Purpose |
|---|---|
| `@basaltkit/http` | Framework-neutral core — typed routes, pipeline, error mapping, edge plugins |
| `@basaltkit/fastify` · `@basaltkit/express` · `@basaltkit/hono` | Adapters — the same routes run on any of them |
| `@basaltkit/sdk` | Type-safe client inferred from Zod endpoint definitions |

## Data & infrastructure

| Package | Purpose |
|---|---|
| `@basaltkit/prisma` | Tenant-scoping client extension, per-tenant LRU client pool, `ctx().db` |
| `@basaltkit/cache` | Redis/Memory drivers, tags, TTL, stampede protection, per-tenant keys |
| `@basaltkit/cache-tiered` | Multi-level cache driver — in-process near cache in front of Redis |
| `@basaltkit/storage` | Local/S3/MinIO under one contract, tenant isolation, signed URLs |
| `@basaltkit/storage-gcs` · `@basaltkit/storage-azure` | Google Cloud Storage & Azure Blob drivers |
| `@basaltkit/mailer` | Typed declarative mails, SMTP/log/memory drivers, tenant sender |
| `@basaltkit/scheduler` | Fluent cron: `schedule.job(X).daily().at('03:00')` |

## Queues

| Package | Purpose |
|---|---|
| `@basaltkit/queue` | Declarative jobs, context propagation, pluggable driver + capability checks |
| `@basaltkit/queue-rabbitmq` | RabbitMQ driver — retries, backoff, delay, priority via DLX |
| `@basaltkit/queue-kafka` | Kafka driver — produce/consume with retry + dead-letter topics |
| `@basaltkit/queue-sqs` | Amazon SQS driver — native delay, retries with backoff, DLQ |

## SaaS domain

| Package | Purpose |
|---|---|
| `@basaltkit/tenancy` | Resolvers, per-request tenant context, lifecycle hooks |
| `@basaltkit/tenancy-sqlite` · `@basaltkit/tenancy-prisma` | Durable backends for the `@basaltkit/tenancy` TenantSource — persist the tenant registry and custom domains; SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/auth` | Password hashing, JWT + refresh rotation, sessions, email verification, password reset, API keys, MFA (TOTP) |
| `@basaltkit/auth-sqlite` | Durable SQLite (`node:sqlite`) backend for every `@basaltkit/auth` store — survives restarts, zero deps |
| `@basaltkit/auth-prisma` | Prisma backend for every `@basaltkit/auth` store — Postgres/MySQL, ships a reference schema, pass your `PrismaClient` |
| `@basaltkit/permissions` | Roles, wildcard permissions, policies, tenant scoping, super admin |
| `@basaltkit/permissions-sqlite` · `@basaltkit/permissions-prisma` | Durable backends for the `@basaltkit/permissions` AccessStore — SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/teams` | Multi-user tenants — roles, email invitations, membership, `teamRole` guard |
| `@basaltkit/teams-sqlite` · `@basaltkit/teams-prisma` | Durable backends for the `@basaltkit/teams` stores — SQLite (`node:sqlite`, zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/subscriptions` | Plans, trials, feature limits, gateway drivers, hosted Checkout & Portal, proration |
| `@basaltkit/subscriptions-sqlite` · `@basaltkit/subscriptions-prisma` | Durable backends for the subscription, usage (atomic `consume`) and webhook stores — SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/flags` | Feature flags — per-tenant/user targeting, deterministic rollouts |
| `@basaltkit/webhooks` | Outbound webhooks — signed delivery, retries, per-tenant subscriptions |
| `@basaltkit/webhooks-sqlite` · `@basaltkit/webhooks-prisma` | Durable backends for the `@basaltkit/webhooks` WebhookStore — persist endpoint subscriptions across restarts; SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@basaltkit/audit` · `@basaltkit/activity` · `@basaltkit/notifications` | Audit trail, activity feed, multi-channel notifications |
| `@basaltkit/comments-sqlite` · `@basaltkit/comments-prisma` | Durable backends for the `@basaltkit/comments` CommentStore |
| `@basaltkit/audit-sqlite` · `@basaltkit/audit-prisma` · `@basaltkit/activity-sqlite` · `@basaltkit/activity-prisma` · `@basaltkit/notifications-sqlite` · `@basaltkit/notifications-prisma` | Durable SQLite/Prisma backends for the audit, activity and in-app notification stores |

## Capabilities

| Package | Purpose |
|---|---|
| `@basaltkit/realtime` | Server→client push (WebSocket/SSE), per-tenant channels, presence, events bridge, Redis backplane |
| `@basaltkit/realtime-client` | Zero-dep browser client for `@basaltkit/realtime` — subscribe channels, auto-reconnect |
| `@basaltkit/search` | Tenant-scoped full-text search — in-memory (dev) & Meilisearch drivers, auto-sync from events |
| `@basaltkit/search-postgres` | PostgreSQL full-text driver (`tsvector`/`ts_rank`) for `@basaltkit/search` |
| `@basaltkit/files` | Upload pipeline over storage — type/size validation, per-tenant quota, metadata, scan hooks |
| `@basaltkit/comments` | Per-resource comment threads — @mentions, resolve/reopen, events for realtime & notifications |
| `@basaltkit/i18n` | Internationalization — context-resolved locale, typed catalogs with plurals, Intl formatting |
| `@basaltkit/exports` · `@basaltkit/exports-xlsx` | Typed data exports → CSV/TSV/JSON/NDJSON and a zero-dep XLSX formatter |

## Self-contained UIs

Dependency-free HTML pages served over your existing JSON routes.

| Package | Page |
|---|---|
| `@basaltkit/audit-viewer` | `/audit/view` — browse the audit trail (filters, stats) |
| `@basaltkit/api-keys-ui` | `/apikeys/ui` — create/list/revoke API keys |
| `@basaltkit/teams-ui` | `/team/ui` — invitations & members |
| `@basaltkit/billing-ui` | `/billing/ui` — plans, Checkout, Customer Portal |

## Developer experience & product

| Package | Purpose |
|---|---|
| `create-basalt` | Project scaffolder |
| `@basaltkit/cli` · `@basaltkit/generator` | The `basalt` command framework and `basalt make` scaffolding |
| `@basaltkit/testing` | `createTestApp`, mail/queue fakes, time travel |
| `@basaltkit/admin` · `@basaltkit/dashboard` · `@basaltkit/admin-react` · `@basaltkit/admin-shadcn` | Headless admin/dashboard engines + React and shadcn/ui bindings |

## The dependency rule

A package may only depend on packages in a lower layer (foundation →
infrastructure → domain → capabilities). Same-layer packages communicate through
events and core contracts, never direct imports — which is why any package can
be adopted on its own, and why drivers (queue, storage, search, cache) plug in
behind a stable contract.
