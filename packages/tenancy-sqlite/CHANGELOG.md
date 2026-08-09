# @machize/tenancy-sqlite

## 1.0.5

### Initial release

- Durable, SQLite-backed `TenantSource` for `@machize/tenancy`, on Node's
  built-in `node:sqlite` — the single-node counterpart to the in-memory
  `MemoryTenantSource`. Tenants and their custom domains survive a restart.
- `sqliteTenantSource(path)` returns a source ready for `tenancyPlugin({ source })`,
  with `save`/`find`/`findByDomain`/`list`/`remove`. Open tenant records are
  stored as JSON; domains are normalized into an indexed table for keyed
  `findByDomain`. Domains are globally unique — writes are transactional.
