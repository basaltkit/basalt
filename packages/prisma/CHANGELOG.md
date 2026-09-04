# @basaltkit/prisma

## 1.6.2

### Patch Changes

- 36ab1a1: `prisma:sync` can be told which schema each domain belongs to.
  
  The command had one schema path and one flat list of domains. That list mixes
  domains living in every tenant's schema (`auth`, `permissions`, `audit`,
  `activity`, `teams`, `notifications`) with domains living only in the central
  one (`tenancy`, `subscriptions`), and nothing told them apart.
  
  So `prisma:sync --yes` — the obvious invocation — wrote `Tenant`,
  `Subscription` and `Payment` into the schema of every tenant. Those tables must
  never hold a row; having them there is a place for one tenant's data to land
  unnoticed. It was caught by reading a diff, not by the tool.
  
  ```ts
  prismaSyncCommand({
    targets: {
      central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy', 'subscriptions'] },
      tenant: {
        schemaPath: 'prisma/tenants/schema.prisma',
        domains: ['auth', 'permissions', 'audit', 'activity', 'teams', 'notifications'],
      },
    },
  })
  ```
  
  `--only` narrows inside each target and never moves a domain across one.
  `--push`/`--migrate` run once per schema that actually changed, rather than
  producing an empty migration for one that did not. `--schema` is refused when
  targets are declared: it names a single file, and guessing which would write
  central models into it.
  
  Without `targets`, behaviour is unchanged.
- 36ab1a1: Add `tenantClient()` — the per-request client stand-in every schema-per-tenant
  app was writing by hand.
  
  The `-prisma` stores (`auth-prisma`, `permissions-prisma`, `audit-prisma`,
  `activity-prisma`, `teams-prisma`, `notifications-prisma`) take a client when
  they are constructed, at boot, and hold it for the life of the process. Under
  schema-per-tenant the right client is only known per request: it comes from
  `db()`, which reads the context and throws outside one.
  
  The framework already tolerated the workaround — `ensureModel` catches the "not
  yet resolvable" case, commented *"lazy/proxy client (e.g. database-per-tenant) —
  validated at first use"* — but never supplied it, so each application wrote the
  same proxy:
  
  ```ts
  // before
  const tenantDb = new Proxy({} as PrismaClient, {
    get: (_t, prop) => (db() as Record<string | symbol, unknown>)[prop],
  })
  
  // after
  const tenantDb = tenantClient<PrismaClient>()
  ```
  
  Writing that proxy wrong does not raise an error. It points every tenant at
  whatever client was passed instead — usually the central one — so tenant data
  lands in the `public` schema, silently. The version here also forwards through
  `Reflect`, keeping the receiver intact when a store calls a model method, and
  answers `has`/`ownKeys`, which is what the stores' model probes rely on.
  
  Not a replacement for `db()`: inside a request, call `db()`. This is for the
  places that must be constructed before a request exists.

## 1.6.1

### Patch Changes

- c9fa43b: Document combining `client` with `schemaPerTenant`/`forTenant` so one app can
  serve central and tenant routes from the same plugin registration.
  
  The option table already said `client` doubles as "the client for the tenant-less
  context", and one sentence noted the modes combine — but with no example, and
  without the trade-off that makes it worth stating: dropping `client` means a
  tenant route reached with no tenant throws `DB_UNAVAILABLE`, while setting it
  means that same route quietly reads the **central** database instead. The README
  now shows the pairing (`required: true` plus `meta: { tenant: false }` on the
  routes that are genuinely central) that keeps the failure loud.
  
  Docs only — no runtime change.

## 1.6.0

### Minor Changes

- 581fae3: **`migrateTenants` now catches a migration that succeeded without doing anything.**
  
  `prisma migrate deploy` exits 0 when it finds no migrations to apply. A missing
  or empty migrations directory therefore looks exactly like success: the tenant is
  provisioned, the migrator reports `ok: true`, and the schema comes up holding
  `_prisma_migrations` and not one table of its own. The tenant is marked ready and
  the damage surfaces much later, as a query against a table that was never created.
  
  After each tenant migrates, `migrateTenants` now counts the tables in that
  tenant's schema — ignoring `_prisma_migrations` — and reports `ok: false` when
  the count is zero, with `EmptyTenantSchemaError` (`PRISMA_TENANT_SCHEMA_EMPTY`).
  Like every other failure it is reported per tenant and never aborts the run.
  
  It runs in schema mode when `provision` can also read the database; a
  `PrismaClient` satisfies both, so `provision: admin` is enough. Costs one
  `information_schema` query per tenant. Opt out with `verifyTables: false` if a
  tenant legitimately starts with no tables.
  
  ### Why it counts tables and not migrations
  
  `prisma db push` creates tables straight from `schema.prisma`, with no migration
  history at all — a legitimate strategy for disposable tenants. Asking "were
  migrations applied?" would report a false failure there. "Does the tenant have
  tables?" is the right question under both strategies.
  
  New exports: `countTenantTables(client, schema)`, `canInspect(client)`,
  `EmptyTenantSchemaError` and the `SchemaInspector` type.

## 1.5.0

### Minor Changes

- 7b3d2fc: **`prismaMigrator` can now point at a `prisma.config.ts` (`configPath`).**
  
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
- 72d6416: **Fail loud when schema-per-tenant is configured against a database that cannot
  do it.**
  
  Schema-per-tenant is a PostgreSQL feature: it relies on a schema being a
  namespace *inside* a database, selected by the connection's `search_path`. In
  MySQL a "schema" **is** a database; SQLite has no equivalent. Until now,
  configuring it against either surfaced as a raw `CREATE SCHEMA` syntax error
  from the driver — at tenant-creation time, far from the configuration that
  caused it.
  
  Now it is refused where the configuration is read:
  
  - **at boot**, when `prismaPlugin({ schemaPerTenant })` is given a non-PostgreSQL
    URL;
  - **before any migration runs**, in `migrateTenants({ target: { mode: 'schema' } })`.
  
  The message names the alternative — database-per-tenant, via `forTenant` or
  `{ mode: 'database', urlFor }` — which gives stronger isolation anyway.
  
  New exports: `providerOf(url)`, `assertSchemaPerTenantSupported(url)`,
  `SchemaPerTenantUnsupportedError` (`PRISMA_SCHEMA_PER_TENANT_UNSUPPORTED`) and
  the `DatabaseProvider` type.
  
  ### Deliberately not a capability layer
  
  This is a guard, not an abstraction. Translating `mode: 'schema'` into a separate
  database on MySQL would be doing database-per-tenant under a name that says
  otherwise — different backups, different connection limits, different migration
  cost — and that belongs in your config as a decision, not in the framework as a
  silent substitution.
  
  An **unknown** URL scheme is allowed through: `prisma://` and custom poolers
  cannot be classified, and refusing them on a guess would block valid setups.
  
  `migrateTenants` normally reports a failing tenant and carries on. This check is
  the one exception, and intentionally so: in schema mode every tenant shares the
  base URL, so an unsupported database is a configuration error for the whole run.
  Collecting N identical failures would bury the cause.

## 1.4.3

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.4.2

### Patch Changes

- 92947e5: Drop the `@basaltkit/cli` runtime dependency.
  
  `tenantMigrateCommand` and `prismaSyncCommand` imported `defineCommand` (an identity function) and the `CommandDefinition` type from the CLI, dragging the whole CLI module graph (runner, dev, upgrade, builtins) into every production app using Prisma repositories. The commands now use a structural mirror of the CLI's command contract (new exports: `CommandDefinition`, `CommandContext`, `CommandIo`) — the same pattern tenancy/queue/scheduler already use. Byte-identical runtime behavior; commands remain assignable to the CLI's `CommandDefinition` (proven by a compile-time + end-to-end `runCli` test), so `commandsPlugin([...generatorCommands(), prismaSyncCommand()])` keeps working unchanged. `@basaltkit/cli` moves to devDependencies (contract-parity test only).

## 1.4.0

### Minor Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

### Patch Changes

- Updated dependencies [c305a67]
  - @basaltkit/core@1.1.1

## 1.3.0

### Minor Changes

- 26ab7d8: Read replicas: `readReplica({ primary, replicas })` wraps a Prisma client so
  model reads (`findMany`, `count`, `aggregate`, `$queryRaw`, …) round-robin
  across read replicas while writes, transactions and `$executeRaw` stay on the
  primary. It's a dependency-free `Proxy` — pass it straight to
  `prismaPlugin({ client })`. `db().$primary` forces the primary for
  read-your-writes right after a write. With no replicas it returns the primary
  unchanged, so the same wiring runs in every environment.
- 758ee6d: Horizontal sharding: `ShardRouter` maps a key (typically a tenant id) to one of
  a fixed set of database clients with a deterministic FNV-1a hash — a tenant's
  data always lives on the same shard. Wire it with `prismaPlugin({ shards })`,
  which routes each request/tenancy switch to its shard client (long-lived, shared
  by many tenants — no eviction) and disconnects every shard on shutdown. Also
  adds a low-level `resolveClient` escape hatch and `router.all()` for cross-shard
  migrations and fan-out reads.

### Patch Changes

- Updated dependencies [fd5b55c]
  - @basaltkit/core@1.1.0

## 1.2.0

### Minor Changes

- Refuse raw queries (`$queryRaw`/`$executeRaw`) inside a tenant context (`PRISMA_RAW_IN_TENANT`), and add Postgres RLS helpers (`rlsPolicySql`/`setTenantConfigSql`/`tenantConfigParams`) for database-enforced tenant isolation.

## 1.1.0

### Minor Changes

- **SECURITY (behavior change): the tenancy extension now fails closed.**
  `tenancyExtension`'s `onMissingTenant` now defaults to **`'error'`** — a query
  that runs with no tenant in context throws `MissingTenantError` instead of
  silently running **unscoped** (which returned/mutated every tenant's rows). This
  closes a critical cross-tenant exposure (a forgotten job/worker context, or a
  route hit before the tenancy enricher, previously leaked all tenants' data).
  Central/admin code that intentionally runs unscoped must now opt in explicitly
  with `tenancyExtension({ onMissingTenant: 'bypass' })`.

## 1.0.5

### Patch Changes

- `basalt prisma:sync` now also discovers `@basaltkit/tenancy-prisma`,
  `@basaltkit/events-prisma` and `@basaltkit/webhooks-prisma` — their
  `Tenant`/`TenantDomain`, `OutboxEntry` and `WebhookEndpoint` models merge into
  your `schema.prisma` like every other `@basaltkit/*-prisma`.

## 1.0.4

### Patch Changes

- Add the `basalt prisma:sync` command — discovers installed @basaltkit/\*-prisma packages and merges their models into your prisma/schema.prisma (interactive by default; --yes/--all non-interactive, --only=, --push/--migrate, --schema=). Exports prismaSyncCommand + extractSchemaBlocks.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/cli@0.24.0
- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/cli@0.23.0
- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/cli@0.22.0
- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/cli@0.21.0
- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/cli@0.20.0
- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/cli@0.19.0
- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/cli@0.18.0
- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/cli@0.17.0
- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/cli@0.16.0
- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/cli@0.15.0
- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/cli@0.14.0
- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/cli@0.13.0
- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/cli@0.12.0
- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/cli@0.11.0
- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/cli@0.10.0
- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/cli@0.9.0
- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/cli@0.8.1
- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/cli@0.8.0
- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/cli@0.7.0
- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/cli@0.6.0
- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/cli@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/cli@0.5.0
- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/cli@0.4.0
- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/cli@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
