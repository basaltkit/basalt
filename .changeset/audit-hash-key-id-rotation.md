---
'@basaltkit/audit': major
'@basaltkit/audit-sqlite': patch
'@basaltkit/audit-prisma': patch
---

Audit hash chain: every new hash names its algorithm and key id, so the HMAC key can be rotated without invalidating history; `verify` catches a duplicate `seq` at a page boundary (FRAMEWORK-AUDIT "Melhorias" 5).

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
