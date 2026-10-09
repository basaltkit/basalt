# @basaltkit/audit-prisma

## 2.1.0

### Minor Changes

- e6c0ac0: Supports `audit.redact()` (RFC 0003). Both schemas gain the nullable `nonce`, `redaction` and `redactedBy` columns, and `auditMysqlColumnLimits` covers them. You only need the migration when you redact or turn on `erasable`: `nonce` is sent only by v3 entries, so an existing schema keeps appending. `get(id)` validates the id before `findUnique`. `redact()` runs inside one interactive `$transaction`, which does two things:
  - an `updateMany` conditioned on `hash` and `redactedBy`, where a miss maps to `AuditRedactionConflictError`;
  - the attestation `create`, where a unique violation maps to `AuditChainConflictError`.
  
  A client without `updateMany` or `$transaction` is refused with `'unsupported-store'`; `get()` falls back to `findMany` when `findUnique` is absent. The README keeps the blanket `REVOKE UPDATE, DELETE, TRUNCATE` for the app role. It adds a dedicated `audit_eraser` role with column-level `UPDATE` and an optional guard trigger. Requires `@basaltkit/audit` 3.1.

## 2.0.1

### Patch Changes

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
- Updated dependencies [b7171e5]
  - @basaltkit/audit@3.0.0

## 2.0.0

### Major Changes

- e54b7b1: Security and correctness fixes from the framework audit (FA-016..FA-020, FA-H17).
  
  - **Rows outside the chain no longer pass silently (FA-016).** `trail()` serves every row of the table, but `verify()` only read the chain, so a row inserted straight into the database (no `seq`, or a `seq` under `chain = NULL` / a foreign chain name) was listed as history while `verify()` stayed `ok: true`. `verify()` now also reads the tenant's rows outside its chain: rows written before the chain began stay *legacy* (counted in `unchained`, never broken); any other one is listed in the new `unverified` field (ids, at most 100) and fails with `reason: 'unchained-entry'`. The legacy cut-off defaults to the `at` of the chain's first entry and can be set with `verify({ legacyUntil })` (`0` = accept no legacy row) or `basalt audit:verify --legacy-until=<ms>`. New `trail({ chainedOnly: true })` reads only rows in their tenant's chain. `verifyAll()` reports a chain name that maps to no tenant as `'unknown-chain'`. New optional store method `readUnchained(tenantId, { since, limit })`, implemented by the memory, SQLite and Prisma stores (a custom store without it is checked through `query()`).
  - **External anchor (FA-H17).** `verify({ expectedHead: { seq, hash } })` fails with `'truncated'` when the anchored entry is gone (deleting the tail leaves no gap) and `'head-mismatch'` when its hash differs; `verifyAll({ expectedHeads })` does the same per chain key, including a chain deleted wholesale. CLI: `--expected-head=<seq>:<hash>`.
  - **Deep freeze (FA-017).** `record()` and `MemoryAuditStore` keep a deep-frozen copy of the payload, so mutating `entry.payload.x` can no longer rewrite the in-memory history (and break the chain). The caller's own object is never frozen.
  - **Redaction gaps (FA-018).** Secret keys are matched on the key's words (`isSensitiveKey`, now exported): `pwd`, `privateKey`, `jwt`, `auth`, `accessKey`, `client_secret`, `dsn`, `connectionString`, `sessionId`… are masked, while `compass`, `bypass`, `author` and `sessionCount` no longer are. A `__proto__` / `constructor` / `prototype` key stays visible as an own property with the value `'[redacted]'` instead of making the subtree vanish into the copy's prototype. `redactSensitiveAndPii` now pseudonymizes phone-shaped values as the README promised — international form only (`+` and 8–15 digits), so order ids, dates and amounts are left alone.
  - **Tenant scoping (FA-019).** `verifyAll()` inside a tenant context verifies and reports only that tenant's chain, like `verify()`. The README now spells out that a hand-built `new Audit(store)` assumes a single-tenant app (pass `tenancyActive: () => true` otherwise).
  - **Filter validation (FA-020).** New `assertAuditQuery()`, applied by `trail()`, `systemTrail()` and every bundled store: `tenantId`, `actorId` and `event` must be strings, `since` a finite number, `chainedOnly` a boolean, `limit` a non-negative safe integer. Previously the Prisma store copied `{ not: 'x' }` (what `qs` makes of `?tenantId[not]=x`) into `where` — reading every other tenant — and passed an unvalidated `limit` to `take`.
  
  **Why major:** no export or option was removed, but behaviour that existing code can observe changed (all of it on broken or unsafe paths): `verify()` now fails where it wrongly passed (a row outside the chain written after it began — if that is a known, benign source such as replicas still running without `integrity` during a rolling deploy, pass `legacyUntil`); `trail()`/stores throw a `TypeError` for filters that were never valid for the declared types; the redactor masks more real secret keys and stops masking a few ordinary words (`compass`, `bypass`, `sessionCount`). `AuditVerifyResult` gained a required `unverified` field — code that constructs such results by hand (not just reads them) must add it.

### Minor Changes

- b69ea05: `SqliteAuditStore` and `PrismaAuditStore` implement the optional `AuditStore.auditTenants()`.
  
  `Audit.verifyAll()` must also visit tenants whose rows were all written outside
  a chain (a forged seq-less insert for a tenant that never had one). Without
  `auditTenants()` it found them by scanning `query({})` — a read of the whole
  trail on every run. Both stores now answer with one `SELECT DISTINCT` on the
  tenant column (served by the existing `(tenant_id, at)` / `[tenantId, at]`
  index); rows without a tenant come back as `undefined`, as in
  `MemoryAuditStore`. No schema change.
- b69ea05: MySQL no longer truncates long values silently (framework audit FA-070).
  
  On MySQL Prisma maps a bare `String` to `VARCHAR(191)`, and a server outside
  strict mode cuts a longer value with only a warning: a webhook URL delivered
  elsewhere, a file `path` stopped naming its object, JSON payloads stopped
  parsing, and a truncated audit payload or hash broke the hash chain for good.
  
  - Each package ships **`schema.mysql.prisma`** (exported as
    `@basaltkit/<pkg>/schema.mysql.prisma`): the same models with the free-text
    columns widened (`@db.Text`, `@db.MediumText`, `@db.VarChar(255)`) and the
    keys left at `VARCHAR(191)`. `comments-prisma`'s variant stores `mentions` as
    `Json` (MySQL has no scalar lists); the store now reads either form.
  - Every factory and store class takes an optional **`columnLimits`**
    (`'mysql'` — the preset matching that schema, exported as
    `<domain>MysqlColumnLimits` — or your own per-model limits, in characters or
    `{ bytes }`). With it set, a value longer than its column is refused with
    `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, 422) before anything is
    written. The outbox's diagnostic `lastError` is shortened (marked
    `…[truncated]`) instead, so `markFailed` still counts the attempt.
  - `basalt prisma:sync` (`@basaltkit/prisma`) copies the MySQL variant when the
    app's `datasource` provider is `mysql`, and warns about a package without one.
  
  Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
  calls keep their signatures (the option is a new trailing parameter).

### Patch Changes

- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/audit@2.0.0

## 1.2.0

### Minor Changes

- b0cc59f: Verifiable audit trail and request context (BK-010).
  
  - `integrity: 'hash-chain'` (on `auditPlugin` / `new Audit(store, redact, tenancyActive, options)`, default `'none'`): every entry gets `seq`, `prevHash` and `hash` = SHA-256 over `prevHash` + a canonical serialization (stable key order, explicit fields incl. tenant, seq, timestamp, actor, event, request, ip/user-agent and the payload as persisted). One chain per tenant plus a system chain. `{ mode: 'hash-chain', key }` makes it HMAC-SHA256 under a >=128-bit secret. Appends are serialized per chain in-process; across replicas the store rejects a duplicate `(chain, seq)` with `AuditChainConflictError` and `Audit` re-reads the head and retries (jittered, up to 10 attempts), so concurrent writers cannot fork a chain.
  - `audit.verify({ tenantId?, from?, to? })` → `{ ok, tenantId, checked, unchained, firstBrokenAt?, entryId?, reason?, head? }` detects edited, deleted, reordered and forged rows (`hash-mismatch`, `prev-hash-mismatch`, `sequence-gap`, `sequence-duplicate`, `missing-predecessor`); tenant-scoped like `trail()`. `audit.verifyAll()` (system-only) checks every chain. Rows written before integrity was enabled are reported as `unchained`, never broken. With integrity on, the plugin registers a `basalt audit:verify [--tenant=<id> | --all] [--from --to]` command (exit 1 when broken); `createAuditVerifyCommand()` is exported.
  - `AuditStore` gains optional `chainHead` / `readChain` / `countUnchained` / `chainTenants` (implemented by `MemoryAuditStore` and both drivers). Exported helpers: `computeAuditHash`, `canonicalAuditEntry`, `AUDIT_CHAIN_GENESIS`, `auditChainKey`, `parseAuditChainKey`.
  - `requestContext: true | (ctx) => ({ ip?, userAgent? })` (default off — IP is PII): `true` registers an `http:enrichers` entry (fastify, express and hono alike) that sets `ctx().client`; entries then carry `ip` and `userAgent` (truncated to 512 chars). The fields go through the configured redactor, so `createPiiMinimizingRedactor` stores a pseudonym of the IP.
  - `redactSensitiveAndPii` / the PII-minimizing redactor now also pseudonymize IP-address keys (`ip`, `ipAddress`, `clientIp`, `remoteAddr`, `x-forwarded-for`, matched exactly).
  - `@basaltkit/audit-sqlite`: new `chain`, `seq`, `prev_hash`, `hash`, `ip`, `user_agent` columns and a unique `(chain, seq)` index, added to existing databases automatically by `migrate()`.
  - `@basaltkit/audit-prisma`: the reference model gains `ip`, `userAgent`, `chain`, `seq`, `prevHash`, `hash` (all nullable) and `@@unique([chain, seq])`; a P2002 on it maps to `AuditChainConflictError`. The new columns are only written when integrity / request capture is enabled, so upgrading without a migration keeps working — migrate before enabling them (README has the PostgreSQL SQL, plus the recommended `REVOKE UPDATE, DELETE ON audit_entries FROM app_role`). `PrismaAuditClient` accepts an optional `count` delegate.

## 1.1.0

### Minor Changes

- 104cfb3: Audit queries push their limit into the database instead of loading the whole trail.
  
  Both stores ran `findMany` / `SELECT *` with no `take` / `LIMIT` and applied the event pattern and the limit **in JavaScript afterwards**. An authenticated `GET /audit?limit=50` therefore materialised the entire, unbounded tenant trail — a repeatable OOM on any endpoint that forwards client input.
  
  Exact filters now push down, including an event name with no wildcard (`take: limit` / `LIMIT n`). Only a wildcard pattern still needs matching in code, and then rows are read in bounded 500-row pages that stop as soon as the limit is satisfied. A pattern containing `.` is deliberately *not* pushed down: `patternMatches` treats `.` and `:` as interchangeable separators, so an equality would miss `a:b` for the pattern `a.b`.
  
  Results are unchanged — same rows, same order, same limit semantics — only peak memory differs.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `basalt prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @basaltkit/audit `AuditStore` (append-only, with the event wildcard), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaAuditStore(prisma)` returns the store named to drop straight into `auditPlugin`. The production counterpart to `@basaltkit/audit-sqlite`.
