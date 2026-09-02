---
'@basaltkit/prisma': minor
---

**`prismaMigrator` can now point at a `prisma.config.ts` (`configPath`).**

Tenants usually keep their own schema file, and therefore their own migration
history. `schemaPath` could not express that, because `migrations.path` is a
property of the *config*, not of the schema: `--schema` moved the models while
Prisma went on applying the central migration history.

The failure was quiet and easy to misread — a freshly provisioned tenant came up
holding `_prisma_migrations` and none of its own tables, which looks like a
broken schema path rather than a migration history pointing somewhere else.

```ts
prismaMigrator({ configPath: './prisma/tenants/prisma.config.ts' })
```

Both options may be set; `--config` is passed first. Two Prisma behaviours are
worth knowing, since neither is guessable and both bite here: paths inside a
config file resolve against **that file's own directory**, not the project root;
and a loaded config makes Prisma skip its usual `.env` loading, so the config
must read its URL from the environment. `prismaMigrator` always sets
`DATABASE_URL` to the tenant's scoped URL, so `env('DATABASE_URL')` resolves to
the right tenant.

Also exports `prismaMigrateArgs(options)`, the pure argv builder, so the flag
wiring is unit-testable without a Prisma CLI or a live database.
