# Packages

Machize is a set of small, focused packages under the `@machize/*` scope. Each
works on its own; together they form the framework. Versions move in lockstep
(currently **0.31.0**, 69 packages).

## Foundation

| Package | Purpose |
|---|---|
| `@machize/core` | DI container, plugin lifecycle, `AsyncLocalStorage` context, hooks |
| `@machize/config` | Namespaced, typed configuration with dot-path access |
| `@machize/env` | Zod-validated environment variables with an aggregated report |
| `@machize/events` | Typed domain event bus with wildcards and priorities |
| `@machize/logger` | Pino logger, auto-enriched with request/tenant context, redaction |

## HTTP

| Package | Purpose |
|---|---|
| `@machize/http` | Framework-neutral core — typed routes, pipeline, error mapping, edge plugins |
| `@machize/fastify` · `@machize/express` · `@machize/hono` | Adapters — the same routes run on any of them |
| `@machize/sdk` | Type-safe client inferred from Zod endpoint definitions |

## Data & infrastructure

| Package | Purpose |
|---|---|
| `@machize/prisma` | Tenant-scoping client extension, per-tenant LRU client pool, `ctx().db` |
| `@machize/cache` | Redis/Memory drivers, tags, TTL, stampede protection, per-tenant keys |
| `@machize/cache-tiered` | Multi-level cache driver — in-process near cache in front of Redis |
| `@machize/storage` | Local/S3/MinIO under one contract, tenant isolation, signed URLs |
| `@machize/storage-gcs` · `@machize/storage-azure` | Google Cloud Storage & Azure Blob drivers |
| `@machize/mailer` | Typed declarative mails, SMTP/log/memory drivers, tenant sender |
| `@machize/scheduler` | Fluent cron: `schedule.job(X).daily().at('03:00')` |

## Queues

| Package | Purpose |
|---|---|
| `@machize/queue` | Declarative jobs, context propagation, pluggable driver + capability checks |
| `@machize/queue-rabbitmq` | RabbitMQ driver — retries, backoff, delay, priority via DLX |
| `@machize/queue-kafka` | Kafka driver — produce/consume with retry + dead-letter topics |
| `@machize/queue-sqs` | Amazon SQS driver — native delay, retries with backoff, DLQ |

## SaaS domain

| Package | Purpose |
|---|---|
| `@machize/tenancy` | Resolvers, per-request tenant context, lifecycle hooks |
| `@machize/auth` | Password hashing, JWT + refresh rotation, sessions, email verification, password reset, API keys, MFA (TOTP) |
| `@machize/auth-sqlite` | Durable SQLite (`node:sqlite`) backend for every `@machize/auth` store — survives restarts, zero deps |
| `@machize/auth-prisma` | Prisma backend for every `@machize/auth` store — Postgres/MySQL, ships a reference schema, pass your `PrismaClient` |
| `@machize/permissions` | Roles, wildcard permissions, policies, tenant scoping, super admin |
| `@machize/permissions-sqlite` · `@machize/permissions-prisma` | Durable backends for the `@machize/permissions` AccessStore — SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@machize/teams` | Multi-user tenants — roles, email invitations, membership, `teamRole` guard |
| `@machize/teams-sqlite` · `@machize/teams-prisma` | Durable backends for the `@machize/teams` stores — SQLite (`node:sqlite`, zero-dep) and Prisma (Postgres/MySQL) |
| `@machize/subscriptions` | Plans, trials, feature limits, gateway drivers, hosted Checkout & Portal, proration |
| `@machize/subscriptions-sqlite` · `@machize/subscriptions-prisma` | Durable backends for the subscription, usage (atomic `consume`) and webhook stores — SQLite (zero-dep) and Prisma (Postgres/MySQL) |
| `@machize/flags` | Feature flags — per-tenant/user targeting, deterministic rollouts |
| `@machize/webhooks` | Outbound webhooks — signed delivery, retries, per-tenant subscriptions |
| `@machize/audit` · `@machize/activity` · `@machize/notifications` | Audit trail, activity feed, multi-channel notifications |
| `@machize/comments-sqlite` · `@machize/comments-prisma` | Durable backends for the `@machize/comments` CommentStore |
| `@machize/audit-sqlite` · `@machize/audit-prisma` · `@machize/activity-sqlite` · `@machize/activity-prisma` · `@machize/notifications-sqlite` · `@machize/notifications-prisma` | Durable SQLite/Prisma backends for the audit, activity and in-app notification stores |

## Capabilities

| Package | Purpose |
|---|---|
| `@machize/realtime` | Server→client push (WebSocket/SSE), per-tenant channels, presence, events bridge, Redis backplane |
| `@machize/realtime-client` | Zero-dep browser client for `@machize/realtime` — subscribe channels, auto-reconnect |
| `@machize/search` | Tenant-scoped full-text search — in-memory (dev) & Meilisearch drivers, auto-sync from events |
| `@machize/search-postgres` | PostgreSQL full-text driver (`tsvector`/`ts_rank`) for `@machize/search` |
| `@machize/files` | Upload pipeline over storage — type/size validation, per-tenant quota, metadata, scan hooks |
| `@machize/comments` | Per-resource comment threads — @mentions, resolve/reopen, events for realtime & notifications |
| `@machize/i18n` | Internationalization — context-resolved locale, typed catalogs with plurals, Intl formatting |
| `@machize/exports` · `@machize/exports-xlsx` | Typed data exports → CSV/TSV/JSON/NDJSON and a zero-dep XLSX formatter |

## Self-contained UIs

Dependency-free HTML pages served over your existing JSON routes.

| Package | Page |
|---|---|
| `@machize/audit-viewer` | `/audit/view` — browse the audit trail (filters, stats) |
| `@machize/api-keys-ui` | `/apikeys/ui` — create/list/revoke API keys |
| `@machize/teams-ui` | `/team/ui` — invitations & members |
| `@machize/billing-ui` | `/billing/ui` — plans, Checkout, Customer Portal |

## Developer experience & product

| Package | Purpose |
|---|---|
| `create-machize` | Project scaffolder |
| `@machize/cli` · `@machize/generator` | The `mach` command framework and `mach make` scaffolding |
| `@machize/testing` | `createTestApp`, mail/queue fakes, time travel |
| `@machize/admin` · `@machize/dashboard` · `@machize/admin-react` · `@machize/admin-shadcn` | Headless admin/dashboard engines + React and shadcn/ui bindings |

## The dependency rule

A package may only depend on packages in a lower layer (foundation →
infrastructure → domain → capabilities). Same-layer packages communicate through
events and core contracts, never direct imports — which is why any package can
be adopted on its own, and why drivers (queue, storage, search, cache) plug in
behind a stable contract.
