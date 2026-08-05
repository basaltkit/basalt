# Packages

Machize is a set of small, focused packages under the `@machize/*` scope. Each
works on its own; together they form the framework. Versions move in lockstep.

## Foundation

| Package | Purpose |
|---|---|
| `@machize/core` | DI container, plugin lifecycle, `AsyncLocalStorage` context, hooks |
| `@machize/config` | Namespaced, typed configuration with dot-path access |
| `@machize/env` | Zod-validated environment variables with an aggregated report |
| `@machize/events` | Typed domain event bus with wildcards and priorities |
| `@machize/logger` | Pino logger, auto-enriched with request/tenant context, redaction |

## Infrastructure

| Package | Purpose |
|---|---|
| `@machize/fastify` | HTTP adapter — typed routes, request enrichers, route guards |
| `@machize/prisma` | Tenant-scoping client extension, per-tenant LRU client pool, `ctx().db` |
| `@machize/cache` | Redis/Memory drivers, tags, TTL, stampede protection, per-tenant keys |
| `@machize/queue` | BullMQ jobs with Zod payloads and context propagation to workers |
| `@machize/scheduler` | Fluent cron: `schedule.job(X).daily().at('03:00')` |
| `@machize/storage` | S3/MinIO/local under one contract, tenant isolation, signed URLs |
| `@machize/mailer` | Typed declarative mails, SMTP/log/memory drivers, tenant sender |
| `@machize/cli` | The `mach` command framework |

## SaaS domain

| Package | Purpose |
|---|---|
| `@machize/tenancy` | Resolvers, per-request tenant context, lifecycle hooks |
| `@machize/auth` | Password hashing, JWT with refresh rotation, sessions, `/auth` routes |
| `@machize/permissions` | Roles, wildcard permissions, policies, tenant scoping, super admin |
| `@machize/subscriptions` | Plans, trials, feature limits, gateway drivers, idempotent webhooks |
| `@machize/audit` | Append-only trail, auto-records hooks and domain events |
| `@machize/activity` | User-facing activity feed (Spatie Activitylog-style) |
| `@machize/notifications` | Multi-channel: in-app, mail, custom drivers, preferences |

## Developer experience & product

| Package | Purpose |
|---|---|
| `create-machize-app` | Project scaffolder |
| `@machize/testing` | `createTestApp`, mail/queue fakes, time travel |
| `@machize/sdk` | Type-safe client inferred from Zod endpoint definitions |
| `@machize/generator` | `mach make` code scaffolding |
| `@machize/admin` | Headless admin kit — table/form/validation from Zod schemas |
| `@machize/dashboard` | Headless dashboard model — billing metrics, section registry |
| `@machize/admin-react` | React binding: `DataTable`, `ResourceForm`, data hooks |

## The dependency rule

A package may only depend on packages in a lower layer (foundation →
infrastructure → domain → product). Same-layer packages communicate through
events and core contracts, never direct imports — which is why any package can
be adopted on its own.
