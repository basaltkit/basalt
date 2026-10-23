---
"@basaltkit/prisma": patch
---

Correction to the 4.1.0 notes on `pgSchemaClient`: it does **not** carry schema-per-tenant over to Prisma 8.

4.1.0 said the `search_path` it sets is honoured "by every Prisma version and driver, for model queries and raw SQL", and that on a later Prisma only the `build` function changes. Both are wrong for Prisma 8. Its ORM names the schema in every statement (`"public"."Project"`), so a connection's `search_path` does not move model queries, and its client has no `schema` option. This was verified against the Prisma 8 release candidate in `apps/prisma8-integration`.

On Prisma 7 nothing changes, and `pgSchemaClient` is correct as documented there: the adapter's `schema` option carries the model queries and the `search_path` carries raw SQL. The JSDoc, the README and the tenancy and database-per-tenant guides now say so. Basalt will ship a supported Prisma 8 path when Prisma 8 is stable.
