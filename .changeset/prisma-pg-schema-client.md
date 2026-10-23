---
"@basaltkit/prisma": minor
---

`pgSchemaClient` and `pgSchemaConnection`: schema-per-tenant that works on Prisma 7 and does not depend on the Prisma version.

`schemaPerTenant` hands `createClient` a URL with `?schema=<name>`. A Prisma 7 driver adapter ignores that parameter, so a factory that only forwards the URL puts every tenant in `public`. `pgSchemaClient(build)` sets the tenant's schema on the connection's `search_path` (the libpq `options` parameter in the connection string, honoured by node-postgres and so by `@prisma/adapter-pg`, and by a client built on a `pg.Pool`), then calls `build({ connectionString, schema, searchPath })`. It fails closed: a URL without a schema, or a schema that is not a plain identifier, throws `PgSchemaConnectionError` instead of connecting.

```ts
createClient: pgSchemaClient(({ connectionString, schema }) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) })),
```

Basalt never builds the client itself: on a later Prisma, only `build` changes. Tested end to end against PostgreSQL with Prisma 7 and `PrismaPg`: rows land in each tenant's schema, raw SQL runs there, and nothing reaches `public`.
