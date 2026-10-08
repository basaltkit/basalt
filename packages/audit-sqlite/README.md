<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/audit-sqlite

Durable, **SQLite-backed** implementation of the
[`@basaltkit/audit`](https://github.com/basaltkit/basalt/tree/main/packages/audit)
`AuditStore` — the append-only audit trail — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

Swap it in for the in-memory store and the trail survives a restart — no ORM, no
migration tool, no service. The single-node reference backend; the production
(Postgres/MySQL) counterpart is
[`@basaltkit/audit-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma).

```bash
pnpm add @basaltkit/audit-sqlite   # peer: @basaltkit/audit
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

```ts
import { auditPlugin } from '@basaltkit/audit'
import { sqliteAuditStore } from '@basaltkit/audit-sqlite'

const a = sqliteAuditStore('./data/audit.db')   // ':memory:' by default

const app = await createApp({
  plugins: [auditPlugin({ store: a.store })],
}).boot()
```

`SqliteAuditStore` is also exported and takes a `DatabaseSync`, so it can share a
handle with the other `*-sqlite` stores. `openAuditDatabase()` and `migrate()`
are exported too.

## Verifiable trail and request context

The store supports everything `@basaltkit/audit` can record:

```ts
auditPlugin({ store: a.store, integrity: 'hash-chain', requestContext: true })
```

- **Hash chain** — `seq`, `prev_hash`, `hash` and a `chain` key (`'t:<tenantId>'` or `'@system'`) are stored per row, with a **unique index on `(chain, seq)`**: two processes appending to the same file cannot fork a chain — the loser gets `AuditChainConflictError` and `Audit` retries on the new head. `audit.verify()` / `basalt audit:verify` read the chain back in `seq` order. The `hash` column stores the self-describing hash as written (`v2:hmac-sha256:<keyId>:<hex>`), so key ids and key rotation need no schema change.
- **Request context** — `ip` and `user_agent` columns.
- **Automatic migration** — `migrate()` (run by `openAuditDatabase()` / `sqliteAuditStore()`) adds the new columns and the index to an existing database with `ALTER TABLE`. Rows written before keep NULLs and are reported by `verify()` as *unchained* (legacy), never as broken.
- **Rows outside the chain** — `readUnchained()` finds every row of a tenant that is not in its chain: a row with `chain IS NULL` but a `seq`, or a `chain` name that is not the tenant's, is always reported by `verify()` (`unverified`, `ok: false`); a seq-less row only when it was written after the chain began. `trail({ chainedOnly: true })` leaves them out, and `verifyAll()` reports a chain name that maps to no tenant as `unknown-chain`. `verifyAll()` also visits tenants whose rows are all outside a chain, found with one `SELECT DISTINCT tenant_id` (`auditTenants()`) rather than a read of the whole trail.
- SQLite has no roles to `REVOKE UPDATE, DELETE` from: protect the database file with filesystem permissions (only the app user can write it) and back it up; for a keyed chain see `integrity: { mode: 'hash-chain', key }` in the [`@basaltkit/audit` README](https://github.com/basaltkit/basalt/tree/main/packages/audit#verifiable-trail-hash-chain).

## Erasing personal data

`audit.redact()` / `audit.systemRedact()` (see the
[`@basaltkit/audit` README](https://github.com/basaltkit/basalt/tree/main/packages/audit#erasing-personal-data-auditredact))
work on this store as they are:

- `migrate()` adds two nullable columns: `redaction` (the erased set, as stable
  JSON) and `redacted_by` (the id of the `audit:redacted` attestation, also the
  optimistic-concurrency token). Existing rows keep NULLs.
- `get(id)` reads one row; `redact(write)` runs in one `BEGIN IMMEDIATE`
  transaction — the row is updated only while its `hash` and `redacted_by` are
  still the ones the redaction was computed from (`AuditRedactionConflictError`
  otherwise), and the attestation is inserted under the `(chain, seq)` index
  (`AuditChainConflictError`). Any error rolls both back.

### Optional guard triggers

SQLite has no roles, so nothing stops a buggy `UPDATE` or `DELETE` on the table.
These triggers do: they refuse every `DELETE`, and every `UPDATE` except an
attested redaction (header and hash columns unchanged, `redacted_by` set). They
guard against **bugs, not attackers** — whoever can open the file can drop them.
Install them once, after `migrate()` (`db.exec(sql)`); do not install them if
your retention policy deletes old rows.

<!-- audit-sqlite:guard-triggers -->
```sql
CREATE TRIGGER IF NOT EXISTS audit_entries_no_delete
BEFORE DELETE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'audit_entries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_entries_redaction_only
BEFORE UPDATE ON audit_entries
WHEN NEW.id IS NOT OLD.id OR NEW.source IS NOT OLD.source OR NEW.event IS NOT OLD.event
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.at IS NOT OLD.at
  OR NEW.chain IS NOT OLD.chain OR NEW.seq IS NOT OLD.seq
  OR NEW.prev_hash IS NOT OLD.prev_hash OR NEW.hash IS NOT OLD.hash
  OR NEW.redacted_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'audit_entries: only an attested redaction may update a row');
END;
```
<!-- /audit-sqlite:guard-triggers -->

## Notes

- **Append-only by contract** — one `audit_entries` table, no delete; the only
  update is the attested erasure above.
- Queries return **newest-first** with the same filters as the in-memory store:
  `tenantId`, `actorId`, `since`, `chainedOnly`, and the **event wildcard** (`auth:**`).
  `limit` always counts only pattern-matched rows. Every filter is type-checked
  (`assertAuditQuery`) even when the store is called directly: a non-string
  `tenantId`/`actorId`/`event` or a non-integer `limit` throws a `TypeError`.
- The `payload` is stored as JSON text and round-trips unchanged.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contract.
- **Query pushdown.** Every exact filter — tenant, actor, `since`, and an event name with **no** wildcard — plus the `limit` go into the database (`take` / `LIMIT`). Only a wildcard pattern still needs matching in code, and then rows are read in bounded 500-row pages that stop as soon as the limit is satisfied, so a `limit: 50` query never materialises the whole trail. A pattern containing `.` is deliberately not pushed down: `patternMatches` treats `.` and `:` as interchangeable separators, so an equality would miss `a:b` for `a.b`.

## License

MIT
