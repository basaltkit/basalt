# @basaltkit/tenancy-prisma

## 1.0.5

### Initial release

- Prisma-backed `TenantSource` for `@basaltkit/tenancy` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryTenantSource`. Bring
  your own `PrismaClient`; ships a reference `schema.prisma` (`Tenant` +
  `TenantDomain`), discoverable by `basalt prisma:sync`.
- `prismaTenantSource(client)` returns a source ready for
  `tenancyPlugin({ source })`, with `save`/`find`/`findByDomain`/`list`/`remove`.
  Open tenant records are stored as JSON; domains are normalized and globally
  unique (rejected up front on conflict). Fails fast when the client lacks the
  `Tenant` model.
