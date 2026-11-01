---
'@basaltkit/prisma': minor
---

`dropTenantSchema(client, schema)`: the mirror of `provisionTenantSchema` — `DROP SCHEMA IF EXISTS "<schema>" CASCADE`, idempotent, name validated, and `public`/`information_schema`/`pg_*` refused. Wire it as `tenancyPlugin({ onDeprovision: (tenant) => dropTenantSchema(db, tenantSchema(tenant.id)) })` so `basalt tenant:destroy` removes the tenant's schema with its record, instead of each app writing that SQL by hand.
