---
'@basaltkit/auth-prisma': major
---

BK-083: API key lifecycle columns. **Breaking: requires a database migration and a regenerated client.**

`AuthApiKey` gains six columns: `serviceId`, `previousHash` (unique), `previousHashExpiresAt`, `rotatedAt`, `allowedIps` and `meta`. There is also an index on `serviceId`. They back `@basaltkit/auth`'s rotation with grace, service keys, IP allowlist and metadata.

`PrismaApiKeyStore` now:

- implements `ApiKeyStore.update` (one `updateMany` with a compare-and-set on `hash`);
- also finds a key by its `previousHash` in `findByHash`;
- filters `list` by `serviceId`.

Prisma selects every model column, so a client generated from the new schema fails every API-key query until the database has the columns. That makes this a major, not a minor; the 1.5 `expiresAt` minor broke apps exactly this way.

To upgrade, copy the model from the reference schema (or run `basalt prisma:sync`), run `prisma generate`, then run `prisma migrate dev --name add_api_key_lifecycle`. With schema-per-tenant, run `basalt tenant:migrate` too.

On PostgreSQL:

```sql
ALTER TABLE "auth_api_keys" ADD COLUMN "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "meta" JSONB,
ADD COLUMN "previousHash" TEXT,
ADD COLUMN "previousHashExpiresAt" TIMESTAMP(3),
ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "serviceId" TEXT;
CREATE UNIQUE INDEX "auth_api_keys_previousHash_key" ON "auth_api_keys"("previousHash");
CREATE INDEX "auth_api_keys_serviceId_idx" ON "auth_api_keys"("serviceId");
```

On MySQL:

```sql
ALTER TABLE `auth_api_keys` ADD COLUMN `allowedIps` JSON NULL, ADD COLUMN `meta` JSON NULL,
  ADD COLUMN `previousHash` VARCHAR(191) NULL, ADD COLUMN `previousHashExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `rotatedAt` DATETIME(3) NULL, ADD COLUMN `serviceId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `auth_api_keys_previousHash_key` ON `auth_api_keys`(`previousHash`);
CREATE INDEX `auth_api_keys_serviceId_idx` ON `auth_api_keys`(`serviceId`);
```

All the new columns are nullable or default to empty, so existing keys keep working.

Until the migration runs, `ApiKeySchemaOutdatedError` (`AUTH_API_KEY_SCHEMA_OUTDATED`, the same code as before) names the missing columns and carries this SQL. It now also recognises a stale client's `PrismaClientValidationError` ("Unknown argument `previousHash`"). The SQL is exported as `API_KEY_LIFECYCLE_MIGRATION_SQL`.

`authMysqlColumnLimits.AuthApiKey` also bounds `serviceId` and `previousHash`.
