---
'@basaltkit/auth-prisma': patch
---

Surface an un-migrated `auth_api_keys` table as a clear error. `@basaltkit/auth-prisma` 1.5.0 added the nullable `auth_api_keys.expiresAt` column, and applications must add it with a migration (`prisma migrate dev --name add_api_key_expires_at`; on PostgreSQL `ALTER TABLE "auth_api_keys" ADD COLUMN "expiresAt" TIMESTAMP(3);`) — with schema-per-tenant, in every tenant schema, then `basalt tenant:migrate`. Until then every API-key request failed with a raw Prisma `P2022`; `PrismaApiKeyStore` now rethrows a missing-column error as `ApiKeySchemaOutdatedError` (`AUTH_API_KEY_SCHEMA_OUTDATED`) carrying those instructions, with the original error as `cause`. Other errors pass through unchanged. `@basaltkit/auth-prisma` now depends on `@basaltkit/core` for the error base class.
