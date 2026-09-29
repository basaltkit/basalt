# @basaltkit/audit

## 3.0.0

### Major Changes

- b7171e5: Audit hash chain: every new hash names its algorithm and key id, so the HMAC key can be rotated without invalidating history; `verify` catches a duplicate `seq` at a page boundary (FRAMEWORK-AUDIT "Melhorias" 5).
  
  **Breaking — new entries use the v2 hash format.** The v1 hash was a bare 64-hex SHA-256/HMAC that recorded neither the algorithm nor the key, so rotating `integrity.key` made every entry the old key signed fail `verify()`. New entries are now `v2:sha256:<hex>` or `v2:hmac-sha256:<keyId>:<hex>`, and the digest covers a v2 canonical form that includes `alg` and `kid` (relabelling an entry to another key breaks it). The integrity option gains:
  
  - `keyId` — recorded with every entry `key` signs; default `auditKeyId(key)`, a fingerprint derived from the key (the same on every replica);
  - `verifyKeys` — retired keys for verification only, bare (default id) or `{ id, key }`.
  
  `verify` picks each entry's key by id; an id it does not hold fails with the new reason `'unknown-key'`. A keyed verifier refuses unkeyed `v2:sha256` entries (no downgrade to a hash anyone can compute). Legacy v1 entries keep verifying — unkeyed by SHA-256, keyed under any key held — and new entries link onto them, so no data migration is needed.
  
  Migration:
  
  - Nothing to do to keep writing and verifying. To rotate later: `integrity: { mode: 'hash-chain', key: NEW, keyId: '2026-09', verifyKeys: [OLD] }` (a bare `OLD` gets the id it recorded when it was used without `keyId`).
  - Tooling that recomputes hashes itself: `computeAuditHash(entry, key?)` is unchanged and still computes the **v1** hash; use `computeAuditHashV2(entry, { id, key }?)`, or `checkAuditHash(entry, keysById)` to verify either format. `parseAuditHash()` / `isAuditHash()` recognise both.
  - Code that assumed `hash` is 64 hex characters (a column, a regex, `--expected-head`): a v2 hash is up to 144 characters. Both bundled stores and the MySQL preset (`VARCHAR(191)`) fit it; `audit:verify --expected-head=<seq>:<hash>` accepts both formats.
  - Do not roll back to an earlier `@basaltkit/audit` after writing v2 entries: it cannot verify them.
  - An exhaustive `switch` over `AuditVerifyFailure` needs a `'unknown-key'` case.
  
  **Fix — duplicate `seq` at the page boundary.** `verify` reads chains in pages of 500 and started each page at the next `seq`, so in a custom store without the `(chain, seq)` unique index a second row sharing the last `seq` of a page was never read and verification stayed green. Each page now re-reads the last verified entry, and any other row at that `seq` fails as `'sequence-duplicate'`.
  
  `@basaltkit/audit-sqlite` / `@basaltkit/audit-prisma`: documentation (the self-describing hash fits the existing columns — no schema change) and round-trip tests across a key rotation.

## 2.0.0

### Major Changes

- b69ea05: Framework audit residuals: `verifyAll()` coverage and `audit:verify --all=true`.
  
  - **`verifyAll()` visits tenants that have rows but no chain.** It used to verify only tenants listed by `chainTenants()`, so a tenant whose only rows were forged seq-less inserts was never checked. Such tenants are now verified too; their legacy cut-off defaults to the moment integrity began for the whole store (the earliest first entry of any chain), so a row written after it fails with `unchained-entry`. An explicit `legacyUntil` applies to them as well. The tenant list comes from the new optional `AuditStore.auditTenants()` (implemented by `MemoryAuditStore`); a store without it is scanned through `query({})`.
  - **`audit:verify` parses its flags strictly.** `--all=true` (a string) used to be read as "not `--all`": it verified only the system chain and exited 0. `--all`, `--all=true|1|yes` now verify every chain, `--all=false|0|no` a single one, and any other value throws. `--all` combined with `--tenant`/`--from`/`--to`/`--expected-head` throws, and `--tenant` without a value throws instead of silently verifying the system chain.
  
  **Why major:** `verifyAll()` / `audit:verify --all` can now report `ok: false` (exit 1) for a trail they used to pass, and flag combinations that were silently ignored now throw. Migration: if old replicas wrote unchained rows for tenants that never got a chain after integrity was enabled, pass `legacyUntil` (the timestamp the rollout finished). Custom stores should implement `auditTenants()` (`SELECT DISTINCT tenant_id`) to avoid the full scan.
- e54b7b1: Security and correctness fixes from the framework audit (FA-016..FA-020, FA-H17).
  
  - **Rows outside the chain no longer pass silently (FA-016).** `trail()` serves every row of the table, but `verify()` only read the chain, so a row inserted straight into the database (no `seq`, or a `seq` under `chain = NULL` / a foreign chain name) was listed as history while `verify()` stayed `ok: true`. `verify()` now also reads the tenant's rows outside its chain: rows written before the chain began stay *legacy* (counted in `unchained`, never broken); any other one is listed in the new `unverified` field (ids, at most 100) and fails with `reason: 'unchained-entry'`. The legacy cut-off defaults to the `at` of the chain's first entry and can be set with `verify({ legacyUntil })` (`0` = accept no legacy row) or `basalt audit:verify --legacy-until=<ms>`. New `trail({ chainedOnly: true })` reads only rows in their tenant's chain. `verifyAll()` reports a chain name that maps to no tenant as `'unknown-chain'`. New optional store method `readUnchained(tenantId, { since, limit })`, implemented by the memory, SQLite and Prisma stores (a custom store without it is checked through `query()`).
  - **External anchor (FA-H17).** `verify({ expectedHead: { seq, hash } })` fails with `'truncated'` when the anchored entry is gone (deleting the tail leaves no gap) and `'head-mismatch'` when its hash differs; `verifyAll({ expectedHeads })` does the same per chain key, including a chain deleted wholesale. CLI: `--expected-head=<seq>:<hash>`.
  - **Deep freeze (FA-017).** `record()` and `MemoryAuditStore` keep a deep-frozen copy of the payload, so mutating `entry.payload.x` can no longer rewrite the in-memory history (and break the chain). The caller's own object is never frozen.
  - **Redaction gaps (FA-018).** Secret keys are matched on the key's words (`isSensitiveKey`, now exported): `pwd`, `privateKey`, `jwt`, `auth`, `accessKey`, `client_secret`, `dsn`, `connectionString`, `sessionId`… are masked, while `compass`, `bypass`, `author` and `sessionCount` no longer are. A `__proto__` / `constructor` / `prototype` key stays visible as an own property with the value `'[redacted]'` instead of making the subtree vanish into the copy's prototype. `redactSensitiveAndPii` now pseudonymizes phone-shaped values as the README promised — international form only (`+` and 8–15 digits), so order ids, dates and amounts are left alone.
  - **Tenant scoping (FA-019).** `verifyAll()` inside a tenant context verifies and reports only that tenant's chain, like `verify()`. The README now spells out that a hand-built `new Audit(store)` assumes a single-tenant app (pass `tenancyActive: () => true` otherwise).
  - **Filter validation (FA-020).** New `assertAuditQuery()`, applied by `trail()`, `systemTrail()` and every bundled store: `tenantId`, `actorId` and `event` must be strings, `since` a finite number, `chainedOnly` a boolean, `limit` a non-negative safe integer. Previously the Prisma store copied `{ not: 'x' }` (what `qs` makes of `?tenantId[not]=x`) into `where` — reading every other tenant — and passed an unvalidated `limit` to `take`.
  
  **Why major:** no export or option was removed, but behaviour that existing code can observe changed (all of it on broken or unsafe paths): `verify()` now fails where it wrongly passed (a row outside the chain written after it began — if that is a known, benign source such as replicas still running without `integrity` during a rolling deploy, pass `legacyUntil`); `trail()`/stores throw a `TypeError` for filters that were never valid for the declared types; the redactor masks more real secret keys and stops masking a few ordinary words (`compass`, `bypass`, `sessionCount`). `AuditVerifyResult` gained a required `unverified` field — code that constructs such results by hand (not just reads them) must add it.

### Patch Changes

- Updated dependencies [e54b7b1]
  - @basaltkit/core@1.5.0

## 1.6.0

### Minor Changes

- b0cc59f: Verifiable audit trail and request context (BK-010).
  
  - `integrity: 'hash-chain'` (on `auditPlugin` / `new Audit(store, redact, tenancyActive, options)`, default `'none'`): every entry gets `seq`, `prevHash` and `hash` = SHA-256 over `prevHash` + a canonical serialization (stable key order, explicit fields incl. tenant, seq, timestamp, actor, event, request, ip/user-agent and the payload as persisted). One chain per tenant plus a system chain. `{ mode: 'hash-chain', key }` makes it HMAC-SHA256 under a >=128-bit secret. Appends are serialized per chain in-process; across replicas the store rejects a duplicate `(chain, seq)` with `AuditChainConflictError` and `Audit` re-reads the head and retries (jittered, up to 10 attempts), so concurrent writers cannot fork a chain.
  - `audit.verify({ tenantId?, from?, to? })` → `{ ok, tenantId, checked, unchained, firstBrokenAt?, entryId?, reason?, head? }` detects edited, deleted, reordered and forged rows (`hash-mismatch`, `prev-hash-mismatch`, `sequence-gap`, `sequence-duplicate`, `missing-predecessor`); tenant-scoped like `trail()`. `audit.verifyAll()` (system-only) checks every chain. Rows written before integrity was enabled are reported as `unchained`, never broken. With integrity on, the plugin registers a `basalt audit:verify [--tenant=<id> | --all] [--from --to]` command (exit 1 when broken); `createAuditVerifyCommand()` is exported.
  - `AuditStore` gains optional `chainHead` / `readChain` / `countUnchained` / `chainTenants` (implemented by `MemoryAuditStore` and both drivers). Exported helpers: `computeAuditHash`, `canonicalAuditEntry`, `AUDIT_CHAIN_GENESIS`, `auditChainKey`, `parseAuditChainKey`.
  - `requestContext: true | (ctx) => ({ ip?, userAgent? })` (default off — IP is PII): `true` registers an `http:enrichers` entry (fastify, express and hono alike) that sets `ctx().client`; entries then carry `ip` and `userAgent` (truncated to 512 chars). The fields go through the configured redactor, so `createPiiMinimizingRedactor` stores a pseudonym of the IP.
  - `redactSensitiveAndPii` / the PII-minimizing redactor now also pseudonymize IP-address keys (`ip`, `ipAddress`, `clientIp`, `remoteAddr`, `x-forwarded-for`, matched exactly).
  - `@basaltkit/audit-sqlite`: new `chain`, `seq`, `prev_hash`, `hash`, `ip`, `user_agent` columns and a unique `(chain, seq)` index, added to existing databases automatically by `migrate()`.
  - `@basaltkit/audit-prisma`: the reference model gains `ip`, `userAgent`, `chain`, `seq`, `prevHash`, `hash` (all nullable) and `@@unique([chain, seq])`; a P2002 on it maps to `AuditChainConflictError`. The new columns are only written when integrity / request capture is enabled, so upgrading without a migration keeps working — migrate before enabling them (README has the PostgreSQL SQL, plus the recommended `REVOKE UPDATE, DELETE ON audit_entries FROM app_role`). `PrismaAuditClient` accepts an optional `count` delegate.

### Patch Changes

- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2
  - @basaltkit/events@1.3.0

## 1.5.0

### Minor Changes

- fb85c40: Security hardening for the audit trail:
  
  - audit: `trail()`, `systemTrail()` and `MemoryAuditStore` reject a `limit` that is not a non-negative safe integer (new exported `assertAuditLimit`), so a request value forwarded unvalidated can never reach a store.
  - audit-sqlite: `LIMIT`/`OFFSET` are bound parameters instead of being interpolated into the SQL, and the store validates `limit` itself.
  - audit: PII pseudonyms are now HMAC-SHA256 with a configured key and 128-bit output (`createPiiMinimizingRedactor({ key })`, `pseudonymize(value, key)`); without a key a random per-process key is used and a warning is logged, so pseudonyms are no longer reversible by brute force. Pseudonyms change format and do not match those written by earlier versions.
  - audit: every value under a PII key is pseudonymized whatever its shape (a numeric phone, a list of phones, a nested `{ number }` object); before, only a plain string was, so the others reached the trail raw. A pseudonymization key that is not a string or a `Uint8Array` is rejected when the redactor is created.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/events@1.2.0

## 1.4.1

### Patch Changes

- 36ab1a1: Stop the default configuration from breaking tenant provisioning, and add
  `onCaptureError`.
  
  Two independent problems, both from `tenancy:**` being in the default hook
  patterns:
  
  **Tenant creation failed outright.** `tenancy.provision()` runs the provisioning
  callback inside the new tenant's context, which emits `tenancy:switched`. With
  an `AuditStore` bound to the tenant's own database — the natural setup for
  schema-per-tenant — that write hit storage that did not exist yet. The awaited
  listener had no `try/catch`, so the rejection propagated out through
  `provision()`, which marked the tenant `failed` and rethrew. An application
  following the defaults could not create a single tenant.
  
  **The trail filled with routing noise.** `tenancy:switched` also fires on every
  HTTP request that resolves a tenant, so a multi-tenant app wrote one audit row
  per request, forever.
  
  The default patterns now name `tenancy:created` instead of `tenancy:**`: tenant
  lifecycle is worth auditing, context switching is routing. The two were only
  together because one wildcard covered both.
  
  Bridged captures — hooks and events the plugin picks up automatically — no
  longer propagate failures into the operation that emitted them. `onCaptureError`
  reports them, defaulting to a log; the same rule `@basaltkit/realtime` applies to
  its own bridge. A deliberate `audit.record()` still throws, because there the
  audit *is* the operation.
  
  Apps that want the old capture set can pass `hooks: ['auth:**', 'billing:**',
  'tenancy:**', 'permission:**']` explicitly.

## 1.4.0

### Minor Changes

- f3703a1: `trail()` no longer requires tenancy: it fails closed only when `@basaltkit/tenancy` is registered.
  
  `Audit.trail()` threw whenever it could not resolve a tenant — but in an app with no `tenancyPlugin`, `ctx().tenant` is *always* undefined, so the everyday read threw every time and pushed developers onto `systemTrail()`, which the docs (correctly) frame as a dangerous system-only escape hatch. `@basaltkit/audit` is a general-purpose package; requiring the opt-in SaaS layer to read your own audit trail broke the [beyond-SaaS](https://basalt.dev/guide/beyond-saas) promise.
  
  `auditPlugin` now reads tenancy's `tenancy:active` metadata marker — the same signal `@basaltkit/cache` uses — and passes it to `Audit`. A **signal, not an import**: `@basaltkit/audit` still has no dependency on `@basaltkit/tenancy`.
  
  | App | `trail()` with no context tenant and no `tenantId` |
  |---|---|
  | No `tenancyPlugin` | Returns the trail (**changed** — used to throw) |
  | `tenancyPlugin` registered | Still throws, pointing at `systemTrail()` (unchanged) |
  
  Everything else is untouched: a context tenant still FORCES the scope and a caller-supplied `tenantId` still cannot widen it, an explicit `trail({ tenantId })` is still honoured, and `systemTrail()` remains the deliberate cross-tenant read. Multi-tenant apps see no behavior change; single-tenant apps get a bug fix. `new Audit(store, redact, tenancyActive?)` takes an optional third argument (defaults to single-tenant).

## 1.3.0

### Minor Changes

- 104cfb3: The redactors truncate past their depth limit instead of passing the raw subtree through.
  
  Both `redactSensitive` and `redactSensitiveAndPii` stopped at depth 6 by returning the value **unchanged**. Audit payloads are arbitrary and the default subscription is `events: ['**']`, so a `password` nested seven levels deep was persisted to the trail in cleartext — verified. Objects past the bound now become `'[truncated]'`; primitives (whose keys were already checked one level up) are unaffected, so nothing within the limit changes.
  
  Also adds `exactEventMatch()` and `AUDIT_SCAN_PAGE`, the shared helpers the store drivers use to push a query's limit down into the database.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/events@1.1.1

## 1.2.0

### Minor Changes

- `trail()` now forces the context tenant (a caller-supplied `tenantId` cannot widen scope); add `systemTrail()` for explicit cross-tenant reads and an opt-in `piiMinimizingRedactor`.

## 1.1.0

### Minor Changes

- Security hardening (secret redaction + tenant scoping):
  - **Payloads are redacted before storage by default.** The trail captured `auth:**`/`billing:**` hook payloads verbatim, so a password, session/API token or other secret in an event was written to the audit store in plaintext. Payloads now pass through `defaultAuditRedactor`, which recursively masks common secret keys (`password`, `token`, `secret`, `authorization`, `api-key`, `session`, `cookie`, `otp`/`mfa`, …) as `[redacted]`. Override with the `redact` option (`(p) => p` to keep the old verbatim behavior). Exposes `redactSensitive` / `defaultAuditRedactor`.
  - **`trail()` auto-scopes to the current tenant.** It passed the query straight to the store with no default tenant filter (unlike `Activity.query`), so a caller forwarding a client-supplied query — or omitting `tenantId` — could read across tenants. `trail()` now scopes to `ctx().tenant` when one is in context and the query didn't pin a tenant; a system caller outside a tenant context can still query broadly.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/events@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/events@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/events@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/events@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/events@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/events@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/events@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/events@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/events@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/events@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/events@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/events@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/events@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/events@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/events@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/events@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/events@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/events@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/events@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/events@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1
- @basaltkit/events@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/events@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0
- @basaltkit/events@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/events@0.3.0

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
  - @basaltkit/events@0.1.0
