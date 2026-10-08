# RFC 0003 — Erasing personal data from a verifiable audit trail (`audit.redact`)

- **Status:** Draft (phases 0–5 implemented, see §9)
- **Author:** basalt-principal-architect
- **Date:** 2026-10-08
- **Backlog:** BK-087, phase 2 (phase 1 — `fieldPolicies` — shipped in `@basaltkit/audit` 3.0)
- **Affects:** `@basaltkit/audit` (minor), `@basaltkit/audit-sqlite` (minor), `@basaltkit/audit-prisma` (minor); no change to `@basaltkit/audit-viewer`
- **Non-negotiables honoured:** no HTTP surface is added (fastify/express/hono parity untouched); DI via tokens, no decorators; tenancy enforced in the data path, fail-closed; secure-by-default (the default database hardening is not weakened); the AI/MCP layers are untouched and no agent gains an erase capability

---

## 0. TL;DR

The hash chain covers the payload, so today a row that holds personal data can
never be erased without `audit:verify` reporting tampering. Apps subject to
GDPR/LGPD must choose between the law and the integrity check.

This RFC adds **chain-attested redaction**:

1. `audit.redact(entryId, request)` overwrites chosen payload paths with
   `'[erased]'` (and/or drops `ip` / `userAgent`) **in place**, keeping the row's
   original `hash`. The chain links (`prevHash` → `hash`) are therefore intact.
2. In the same transaction it appends an **attestation** — an `audit:redacted`
   entry to the *target row's* chain — that binds the row's `id`, `seq` and
   original `hash`, the set of erased fields, and a SHA-256 digest of the row's
   post-redaction state. The attestation is chained and (on a keyed chain)
   HMAC-signed like every other entry.
3. `verify()` checks a redacted row through its attestation instead of
   recomputing its hash. Every other row is verified exactly as today.

It works on the v1/v2 rows that already exist — no hash rewrite, no migration,
and `expectedHead` anchors recorded outside the database stay valid.

A later, separate phase adds an opt-in **v3 hash** (the v2 canonical form plus a
per-entry random nonce that is destroyed on redaction), so that for rows written
after opting in the stored hash stops being an oracle that confirms a guess of
the erased value.

## 1. Scope

**Goals**

1. Erase personal data from chosen fields of a stored entry while the chain keeps
   verifying.
2. Make every erasure itself accountable: who, when, which fields, under which
   reference — without recording the erased data again.
3. Fail closed: no erasure that could launder tampered content, no silent
   cross-tenant scope, no store that half-supports it.
4. Keep the default hardening (`REVOKE UPDATE, DELETE` for the app role).

**Non-goals** (see §8 for the full list): rewriting hashes, bulk/query-based
erasure APIs, an HTTP route or MCP tool, erasing copies outside the audit table.

## A. Current state (verified on `bk/integration` @ `146e1e80`)

- `packages/audit/src/chain.ts` — `canonicalAuditEntry` (v1/v2; the payload goes
  through `persistedPayload`), `computeAuditHash` (v1), `computeAuditHashV2`,
  `parseAuditHash`, `checkAuditHash` (a keyed verifier refuses `v2:sha256`).
- `packages/audit/src/index.ts`
  - `AuditEntry` (:33) — readonly, no erasure state.
  - `AuditStore` (:147) — "Append-only by contract: no update, no delete".
  - `MemoryAuditStore` (:206).
  - Field-policy path grammar `fieldPath` / `walkFieldPath` (:620–680): dotted
    paths, `[]` segments, prototype keys refused, depth 8, walk 32.
  - `AuditOptions.fieldPolicies` doc (:744–750) states that erasing a value
    later "would break verification" — the gap this RFC closes.
  - `resolveRecordScope` (:893–917) only narrows against the context; outside a
    context with no scope it yields the **system** chain.
  - `record()` (:985) writes `source: 'manual'` and reserves no event names.
  - `trail()` (:1015–1044) refuses a silent system-wide read when tenancy is
    active; `systemTrail()` is the deliberate path.
  - `verifyChain` (:1141) — per entry: seq continuity, `prevHash` link, tenant
    check (:1210), `checkAuditHash` (:1211).
  - `append()` (:1290) — per-chain in-process lock, `AuditChainConflictError`
    retry with jittered backoff (max 10).
  - `build()` (:1329) — field policies, then the redactor, then `frozenPayload`.
- `packages/audit-sqlite/src/index.ts` — `audit_entries`, an `ADD COLUMN`
  migration loop, `UNIQUE (chain, seq)`, no triggers, no update path.
- `packages/audit-prisma/src/index.ts` — `PrismaAuditClient` has only
  `findMany` / `create` / `count?`; the 1.2 columns are sent only when set, so an
  old schema keeps working; `auditMysqlColumnLimits`.
- Hardening docs: `packages/audit/README.md` "Harden the table" and the
  audit-prisma README prescribe `REVOKE UPDATE, DELETE, TRUNCATE`.
- Mukanda (`basaltdocs/src/platform/audit-store.ts`) uses its own
  `HashChainedAuditStore`, not `@basaltkit/audit-prisma`.

## 2. Why attestation, and not a digest chain plus a rechain

The backlog sketch (BK-087) proposed chaining a payload digest instead of the
payload, plus an `audit:rechain --commit` migration. Reading the code changes
that:

- A digest chain changes the hash format of **every future row**, and the rows
  that carry today's PII debt are existing v1/v2 rows — they would still need a
  rechain, which rewrites every `hash`. That breaks every `expectedHead` anchor
  recorded outside the database (the only defence against tail truncation) and
  requires `UPDATE` on hash columns.
- An attestation needs neither. The original hash keeps carrying the links;
  the attestation authenticates the *new* state. Old rows are redactable as they
  are.

**Declined:** the rechain CLI and per-field salted digests / Merkle structures.

What attestation does **not** remove is the *guess oracle*: after erasure, a v1
or v2 hash still lets whoever can compute it confirm a guess of the erased value
(`H(prev ‖ canonical-with-the-guess) == stored hash`). On an unkeyed chain that
is anyone; on a keyed chain only the key holder. §6 handles that two ways: the
residual is reported and gated on every call, and v3 removes it for new rows.

## 3. Public API (all additive)

### 3.1 `chain.ts`

```ts
export const AUDIT_ERASED = '[erased]'
export const AUDIT_REDACTED_EVENT = 'audit:redacted'
/** 'sha256:<hex>' over the redacted row's state (see §5.3). */
export function auditRedactionState(entry: AuditEntry): string

export class AuditRedactionConflictError extends BasaltError   // 'AUDIT_REDACTION_CONFLICT'
export class AuditEntryNotFoundError extends BasaltError       // 'AUDIT_ENTRY_NOT_FOUND', status 404
export class AuditRedactionRefusedError extends BasaltError    // 'AUDIT_REDACTION_REFUSED'
  // readonly reason: 'unverified' | 'residual' | 'unsupported-store'
```

`AuditEntryNotFoundError` is also what another tenant's row yields, so the API is
no existence oracle.

Phase 4 only: `ParsedAuditHash` gains `{ version: 3; alg: 'sha256'; digest }`
and `{ version: 3; alg: 'hmac-sha256'; keyId; digest }`; `computeAuditHashV3`;
`parseAuditHash` / `isAuditHash` / `checkAuditHash` learn v3 (a keyed verifier
refuses `v3:sha256`, exactly as it refuses `v2:sha256`).

### 3.2 `index.ts`

```ts
interface AuditEntry {
  // …existing…
  /** v3 only: random hex mixed into the hash; NULLed when the entry is redacted. (phase 4) */
  readonly nonce?: string | undefined
  /** Present once the entry has been redacted. */
  readonly redaction?: AuditRedactionMarker | undefined
}

interface AuditRedactionMarker {
  /** Id of the latest `audit:redacted` entry attesting this state. */
  readonly attestationId: string
  /** Cumulative payload paths erased (fieldPolicies grammar), or 'all'. */
  readonly payload: readonly string[] | 'all'
  readonly ip: boolean
  readonly userAgent: boolean
}

interface AuditRedactRequest {
  payload?: readonly string[] | 'all'
  ip?: boolean
  userAgent?: boolean
  /** Opaque, non-personal reference (DSR/ticket id), 1–128 printable chars. */
  reasonRef?: string
  /** Highest residual accepted (§6). Default 'keyed'. */
  residual?: 'none' | 'keyed' | 'public'
  /** Pins the tenant when there is no tenant in context (like trail({ tenantId })). */
  tenantId?: string
  /** The eraser when there is no context; must equal the context user when there is one. */
  actorId?: string
}

interface AuditRedactResult {
  entry: AuditEntry
  attestation: AuditEntry | undefined   // undefined when nothing changed
  changed: boolean
  residual: 'none' | 'keyed' | 'public'
}

interface AuditRedactionWrite {
  id: string
  expect: { hash: string | undefined; redactedBy: string | undefined }
  payload: unknown
  ip: string | undefined
  userAgent: string | undefined
  redaction: AuditRedactionMarker
  attestation: AuditEntry
}

interface AuditStore {
  // …existing…
  get?(id: string): Promise<AuditEntry | undefined>
  redact?(write: AuditRedactionWrite): Promise<void>
}

class Audit {
  redact(entryId: string, request: AuditRedactRequest): Promise<AuditRedactResult>
  systemRedact(entryId: string, request: AuditRedactRequest): Promise<AuditRedactResult>
}
```

`AuditVerifyFailure` gains `'redaction-mismatch'`; `AuditVerifyResult` gains
`redacted: number`. Phase 4: `AuditHashChainIntegrity.erasable?: boolean`.

`store.redact(write)` is **the only sanctioned in-place change**, and it is
atomic: it sets `payload`, `ip`, `userAgent` and `redaction`, NULLs `nonce` —
only if the row's `hash` and `redactedBy` still equal `expect` (else
`AuditRedactionConflictError`) — and appends `attestation` in the same
transaction with `append()`'s `(chain, seq)` semantics (`AuditChainConflictError`).
On any error nothing is written.

## 4. Scope and authorization

`redact()` mirrors `trail()`:

| Context | `request.tenantId` | Tenancy active | Effect |
| --- | --- | --- | --- |
| tenant T | ignored | — | only T's rows; any other id → not-found |
| none | T | — | only T's rows |
| none | — | no | any row (single-tenant app) |
| none | — | yes | **throws** — use `systemRedact()` |

`systemRedact()` is the deliberate cross-tenant path for trusted DSR tooling;
`request.tenantId`, when given, still pins. Never forward client input into
either. Authorization (who may erase) is the app's: `redact()` is a service API
the app wraps in its own authorized job, command or route.

The attestation's `tenantId` is **always the target row's**, never derived from
the context (`resolveRecordScope` would put a system-path attestation into the
system chain, and `verifyChain` requires `entry.tenantId === chain tenant`). The
attestation's `actorId` is the context user, else `request.actorId` (a
`TypeError` if the two differ).

## 5. Behaviour

### 5.1 `redact` / `systemRedact`

1. **Validate.** `entryId` 1–256 printable chars; at least one of `payload`,
   `ip`, `userAgent`; payload paths compiled with the `fieldPolicies` compiler
   (shared code: max 64 paths, prototype keys refused, same depth/walk bounds);
   `reasonRef`, `tenantId`, `actorId` bounded and printable; `residual` in the
   enum; the store has `get` and `redact`, else `refused('unsupported-store')`.
2. **Load.** `row = store.get(id)`; missing, or outside the scope → not-found.
   An `audit:redacted` row is refused: it holds no personal data and
   attestations are immutable.
3. **Anti-laundering.** The row must verify *as it is now*: an unredacted
   chained row must pass `checkAuditHash`; an already-redacted row must pass the
   attestation checks of §5.2. Otherwise `refused('unverified')` — without this,
   `redact()` would bless tampered content with a fresh signed attestation. A
   chained row on an `Audit` without integrity is refused too: the attestation
   would be unchained and the row would then fail `verify()`.
4. **Residual** (§6). Above `request.residual` → `refused('residual')`.
5. **Compute** the new state on a copy of the persisted payload: each reached
   path → `AUDIT_ERASED` (absent paths skipped), `'all'` → the payload becomes
   `AUDIT_ERASED`, flagged `ip` / `userAgent` → absent. Merge into the cumulative
   marker. Nothing changed → `{ changed: false, attestation: undefined }`, no
   write.
6. **Attest** under the target chain's in-process lock: `source: 'manual'`,
   `event: AUDIT_REDACTED_EVENT`, `tenantId: row.tenantId`, the eraser's
   `actorId` / `requestId` / request fields, and the fixed payload
   `{ entryId, seq, hash, erased: { payload, ip, userAgent }, state, reasonRef? }`.
   It bypasses `fieldPolicies` and the redactor — a user redactor must not be
   able to mangle `hash` or `state`, and the payload holds no personal data. It
   is chained and hashed like any append; with integrity `'none'` it is a plain
   entry, still the accountability record.
7. **Write** `store.redact(...)`. `AuditChainConflictError` → re-read the head
   and retry (max 10, jittered, as `append()`); `AuditRedactionConflictError` →
   restart from step 2 (max 3), merging into the newer marker. Cross-process
   safety comes from the optimistic `expect` and the `(chain, seq)` unique index;
   the lock is only in-process.

### 5.2 Verify

For each walked entry with a `redaction` marker, every check below must hold,
otherwise `'redaction-mismatch'`:

- the store has `get()` (fail closed, the message names the missing method);
- `att = store.get(marker.attestationId)` exists;
- `att.event === 'audit:redacted'` and `att.source === 'manual'`;
- `att.tenantId === entry.tenantId`;
- for a chained entry, `att.seq` is defined and greater than `entry.seq`;
- `att.payload.entryId`, `.seq`, `.hash` equal the entry's;
- `att.payload.erased` deep-equals the marker minus `attestationId`;
- `att.payload.state === auditRedactionState(entry)`;
- every erased path holds exactly `AUDIT_ERASED` or is absent (`'all'` → the
  payload is `AUDIT_ERASED`); `ip` / `userAgent` are absent when flagged;
- `checkAuditHash(att)` is `'ok'` (for a chained entry; an unchained entry's
  attestation is hash-checked when it carries a hash).

On success the entry counts in `checked` and `redacted`, and its stored hash
continues the links.

The walk also checks each `audit:redacted` attestation it reaches (source
`manual`, hash ok) the other way, otherwise `'redaction-mismatch'` on the
attestation: `store.get(att.payload.entryId)` must exist and carry a marker
whose `attestationId` is `att.id`, or names a later (`seq` greater) attestation
of the same entry and tenant. Without it, a row restored to its original
content and stripped of its marker (from a backup) matches its original hash
again and verifies, and a re-redacted row rolled back to an older attested
state verifies through the older attestation. An attestation outside a `from`/`to` window is hash-checked
on its own; inside the window the walk also link-checks it. Readers
(`describeResult`, the CLI) append `, N redacted`.

### 5.3 The state digest

`auditRedactionState(entry)` = `'sha256:' + SHA-256(stableJson({ r: 1, id, seq,
tenantId, at, source, event, actorId, requestId, ip, userAgent,
payload: persisted(payload), erased: { payload, ip, userAgent } }))`. It binds
every header field, so editing one on a redacted row fails; `prevHash` and
`hash` are bound by the link check and the attestation payload respectively.

### 5.4 Reserved names

`record()` throws a `TypeError` for exactly `'audit:redacted'`. `capture()`
cannot impersonate an attestation: its source is `'hook'` or `'event'`, and
verify requires `'manual'`. The docs reserve the whole `audit:` event prefix;
enforcing it in `record()` / `capture()` is proposed for 4.0 (enforcing it in a
minor could break apps already recording `audit:*` events, or make a hook tap
throw).

What remains after these: an insider with database write access who can also get
the app to `record()` a chosen event named `audit:redacted` — impossible now —
or who holds the key. Verify additionally requires the erased paths to hold the
erased marker, so any residual forgery is narrowed to *erasure*, never
*substitution*.

## 6. Residual guess oracle

| Row hash | Residual | Who can confirm a guess of the erased value |
| --- | --- | --- |
| none (unchained), v3 | `none` | nobody |
| v2 `hmac-sha256`, v1 under a keyed verifier | `keyed` | the integrity key holder |
| v2 `sha256`, v1 unkeyed | `public` | anyone with the row |

The default `residual: 'keyed'` refuses a `public` residual: redacting an
unkeyed legacy row must be acknowledged with `residual: 'public'`.

**v3 (phase 4, opt-in `integrity.erasable: true`).** The canonical form gains a
per-entry `nonce` (256 random bits, hex). `store.redact` NULLs it, so the stored
hash can no longer be recomputed by anyone. Output with `erasable` off is
byte-identical to v2. Guards: `erasable` without a hash chain, or with a store
lacking `get()`, is a `TypeError` at construction; on the first v3 append each
`Audit` reads the row back and throws if the store dropped the nonce (a store
that drops it would make every v3 row unverifiable).

## 7. Storage

New nullable columns everywhere: `nonce` (phase 4), `redaction` (the marker JSON
`{ payload, ip, userAgent }`, stable JSON), `redactedBy` (`redacted_by` in
SQLite) — the attestation id and the optimistic token (an id compared by
equality, not a JSON blob compared across collations).

- **Memory:** `get` / `redact` atomic in-process; `redact` replaces the frozen
  object with a new frozen object.
- **SQLite:** columns via the existing `ADD COLUMN` loop. `redact` =
  `BEGIN IMMEDIATE`; `UPDATE … WHERE id = ? AND hash IS ? AND redacted_by IS ?`
  (0 changes → conflict); `INSERT` the attestation (unique violation → chain
  conflict); `COMMIT`, `ROLLBACK` on any error. **No** `appendOnly` option: an
  append-only trigger is a README snippet (it guards against bugs, not
  attackers — whoever opens the file can drop it).
- **Prisma:** both schemas gain the columns (MySQL: `nonce` / `redactedBy`
  `VARCHAR(191)`, `redaction` `TEXT`), and `auditMysqlColumnLimits` the limits.
  `nonce` is sent only when set, so apps that do not opt in need no migration.
  `PrismaAuditClient` gains optional `findUnique?`, `updateMany?`,
  `$transaction?`; `redact` = an interactive `$transaction` with
  `updateMany({ where: { id, hash, redactedBy } })` (count ≠ 1 → conflict) then
  `create(attestation)`. A client lacking them → `refused('unsupported-store')`.

**Hardening.** The blanket `REVOKE UPDATE, DELETE, TRUNCATE` for the app role
stays the default. Erasure goes through a dedicated `audit_eraser` role:
`GRANT SELECT, INSERT` plus `GRANT UPDATE (payload, ip, "userAgent", nonce,
redaction, "redactedBy")`, an optional monotonic `BEFORE UPDATE` trigger, and a
second store + `new Audit(eraserStore, …sameOptions)` handed only to the DSR
job. Races between the two instances are safe through the store conflicts.

## 8. Not doing (guardrail)

- **Rechain/migrate CLI** — would rewrite hashes and break anchors; attestations
  make it unnecessary. Legacy unkeyed rows keep a residual oracle, surfaced and
  gated by `residual`.
- **Per-field salted digests / Merkle** — the state digest plus the v3 nonce
  cover full and partial erasure.
- **SQLite `appendOnly` option** — a README snippet instead.
- **`AuditRedactionMarker.at`** — it would be unauthenticated; the attestation
  carries the time.
- **Whole-`audit:`-prefix reservation in code** — exact event plus the verify
  source check now; full reservation proposed for 4.0.
- **Column `GRANT UPDATE` for the app role** — only the eraser role gets it.
- **Other entry points** — no `audit:redact` CLI, no bulk `redactWhere`, no HTTP
  route, no MCP tool. A DSR is app logic; an agent must not hold an erase
  capability by default.
- **Copies elsewhere** — events outbox, activity, search indexes, backups:
  separate BK follow-ups; the docs list them in the DSR checklist.
- **4.0 defaults** (`erasable` on, triggers by default) — a separate decision.
- **Mukanda adoption** — app-side under the BK rule; the framework recommends
  moving to `@basaltkit/audit-prisma` rather than re-implementing `get` /
  `redact` on a custom store.
- **audit-viewer badge** — follow-up.

## 9. Phased plan

| Phase | Content |
| --- | --- |
| P0 | This RFC. |
| P1 | `@basaltkit/audit`: errors, constants, `auditRedactionState`, `redact` / `systemRedact`, verify extension, `MemoryAuditStore.get/redact`, `record()` guard, tests. |
| P2 | `@basaltkit/audit-sqlite`: columns, `get`, transactional `redact`, trigger snippet tested. |
| P3 | `@basaltkit/audit-prisma`: schemas, limits, transactional `redact`; pg-integration eraser-role test. |
| P4 | v3 / `erasable` in all three packages. |
| P5 | Docs EN + PT, READMEs, changesets. |

## 10. Decisions

1. **Granularity:** partial path erasure (fieldPolicies grammar) and `'all'`.
2. **Default residual:** `'keyed'` — unkeyed legacy rows need an explicit
   `residual: 'public'`.
3. **4.0 defaults:** deferred to a separate decision.
4. **Attestation source:** `'manual'` (widening the `source` union would break
   exhaustive switches); impersonation is closed by §5.4.
5. **Union widenings** (`'redaction-mismatch'`, v3 `ParsedAuditHash` members)
   ship in minors and are called out in the changesets, as earlier verify
   reasons were.
6. **Rechain / digest chain:** declined (§2).
7. **Hardening:** a dedicated eraser role; the app role keeps the blanket REVOKE.
8. **Out-of-scope copies and backup replay:** separate BK items.
9. **Mukanda:** recommend `@basaltkit/audit-prisma`.

## Appendix — source anchors

| Anchor | Role here |
| --- | --- |
| `packages/audit/src/chain.ts` `canonicalAuditEntry`, `checkAuditHash` | v3 extends them; verify reuses `checkAuditHash` on the attestation |
| `packages/audit/src/index.ts:620-680` `fieldPath`, `walkFieldPath` | path grammar shared by `redact` |
| `packages/audit/src/index.ts:744-750` | fieldPolicies doc to amend |
| `packages/audit/src/index.ts:893-917` `resolveRecordScope` | NOT used for the attestation tenant |
| `packages/audit/src/index.ts:985` `record()` | gains the reserved-event guard |
| `packages/audit/src/index.ts:1015-1044` `trail()` | scope model mirrored by `redact()` |
| `packages/audit/src/index.ts:1141-1231` `verifyChain` | gains the redacted-row branch |
| `packages/audit/src/index.ts:1290-1327` `append`, `withChainLock` | retry/lock model reused |
| `packages/audit-sqlite/src/index.ts:41-74` `migrate` | new columns |
| `packages/audit-prisma/src/index.ts:57-64` `PrismaAuditClient` | optional `findUnique` / `updateMany` / `$transaction` |
