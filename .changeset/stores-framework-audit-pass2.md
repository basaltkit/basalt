---
"@basaltkit/tenancy-prisma": major
"@basaltkit/webhooks-prisma": major
"@basaltkit/webhooks-sqlite": major
"@basaltkit/auth-prisma": major
"@basaltkit/auth-sqlite": patch
"@basaltkit/files-prisma": patch
"@basaltkit/permissions-sqlite": patch
---

Framework audit, pass 2 — persistent stores (FA-068, FA-069, FA-070).

Major for tenancy-prisma, webhooks-prisma, webhooks-sqlite and auth-prisma: a generated PrismaClient still fits the new client interfaces (`$transaction`, `create`/`updateMany`), but hand-written clients and test fakes must add those methods, and cross-scope writes that used to succeed now throw.

- **tenancy-prisma — `save()` / `create()` are atomic (FA-068).** The tenant
  row, the domain check and the domain set (`deleteMany` + `createMany`) now
  run in one interactive `$transaction`. Before, any failure after the delete —
  a domain listed twice, a domain another tenant claimed between the
  pre-flight and the insert, a lost connection — left the tenant rewritten with
  its existing domains gone. Duplicate domains in the array are stored once.
  `PrismaTenancyClient` now includes `$transaction` (a generated
  `PrismaClient` has it; a hand-written client must add it).
- **webhooks-prisma — writes are keyed by `(id, tenantId)` (FA-069).**
  `add()` was an upsert by `id` alone: on MySQL's case-insensitive collation
  tenant A re-registering `ABC` rewrote tenant B's `abc` endpoint (url,
  secret, tenant). It is now an `updateMany` scoped to the endpoint's own
  tenant (or global scope), falling back to `create`; an id held by another
  scope throws the new `WebhookEndpointIdInUseError` (409). Re-adding an id in
  its own scope still replaces it. `PrismaWebhooksClient` now needs
  `create`/`updateMany` instead of `upsert` (a generated `PrismaClient` has
  them).
- **webhooks-sqlite — no `INSERT OR REPLACE` across scopes (FA-070/D8).** The
  manager's check-before-write cannot stop two tenants registering the same id
  at once; the store now refuses an id held by another scope with
  `WebhookEndpointIdInUseError` (409) instead of overwriting that endpoint.
- **auth-prisma — `touch()`/`revoke()` of a missing API key are no-ops
  (FA-070/I4)**, as in the other stores, instead of a Prisma `P2025` thrown
  out of `verify()`. The client surface uses `authApiKey.updateMany` (no longer
  `update`).
- **auth-sqlite — email uniqueness without the NOCASE index (FA-070/D9).** A
  legacy database holding case-variant duplicates cannot build the
  case-insensitive unique index, and `migrate()` skipped it silently; `create`
  now refuses an email that exists in any letter case inside the `INSERT`
  itself, throwing `EmailTakenError` (409) — also for the race between two
  concurrent sign-ups.
- **files-prisma — `prismaFilesStore()` fails fast** when the client has no
  `file` model, like every other `*-prisma` factory (FA-070/I4).
- **permissions-sqlite — multi-permission grants are all-or-nothing**
  (FA-070/I5): `grantToRole` / `grantToUser` run in one savepoint.
