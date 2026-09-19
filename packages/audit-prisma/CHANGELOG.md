# @basaltkit/audit-prisma

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
