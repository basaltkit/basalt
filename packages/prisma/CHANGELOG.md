# @basaltkit/prisma

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
