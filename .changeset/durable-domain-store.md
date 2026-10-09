---
'@basaltkit/tenancy': minor
'@basaltkit/tenancy-prisma': minor
'@basaltkit/tenancy-sqlite': minor
'create-basalt': patch
---

Durable custom-domain stores, and tenant saves that no longer erase them (BK-042).

- `@basaltkit/tenancy-prisma`: new `PrismaDomainStore` / `prismaDomainStore(client)`, and `@basaltkit/tenancy-sqlite`: new `SqliteDomainStore` / `sqliteDomainStore(db)` — durable `DomainStore`s for `CustomDomains` on the existing `tenant_domains` table. `add()` translates the driver's unique violation into `DomainTakenError` (409); `replace()` is one conditional update, so of two concurrent take-overs exactly one wins.
- `save()`/`create()` of both tenant sources now diff the domain set instead of deleting and re-inserting it, and never delete a row that carries a verification token. `tenancy.provision()` (re-runnable by design) and every status change used to wipe a verified custom domain and its proof.
- `findByDomain()` of both sources is fail-closed for claims: a claimed but unverified domain (`victim.com` registered by another tenant) never resolves a request.
- `@basaltkit/tenancy`: new test-only subpath `@basaltkit/tenancy/testing` with `domainStoreContract(makeStore)`, framework-neutral cases (`node:assert`) every `DomainStore` should pass.
- `create-basalt`: the scaffolded `TenantDomain` model carries the new columns.

**Migration (additive).** The bundled `TenantDomain` model gains `verificationToken String?`, `verified Boolean @default(true)`, `createdAt DateTime @default(now())` and `verifiedAt DateTime?`. `basalt prisma:sync` only adds missing models — it does not add columns to a `TenantDomain` model your schema already has — so add the four fields to that model by hand (copy them from `@basaltkit/tenancy-prisma/prisma/schema.prisma`), then run `prisma migrate dev`; existing rows become mirror rows and keep resolving. A new app (or one without the model yet) gets them from `prisma:sync`. Until then, an app whose Prisma client is still generated from the old model keeps working — `PrismaTenantSource` never names the new columns in a query; once the client is regenerated from the new model, migrate before deploying it. The SQLite source adds them on open.

`PrismaTenancyDelegates.tenantDomain` now also requires `findMany` (a generated `PrismaClient` has it; a hand-written client must add it).
