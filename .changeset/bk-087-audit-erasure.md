---
'@basaltkit/audit': minor
---

Erase personal data from a stored entry without breaking the hash chain (RFC 0003, BK-087 phase 2). `audit.redact(entryId, { payload, ip, userAgent, reasonRef, residual, tenantId, actorId })` sets the chosen payload paths (the `fieldPolicies` grammar, or `'all'`) to `'[erased]'` and drops `ip`/`userAgent`. The entry keeps its original `hash`, and an `audit:redacted` attestation is appended to the entry's own chain in the same store transaction. It binds the entry's id, `seq` and `hash`, the erased set and a digest of the new state (`auditRedactionState`). `verify()` checks a redacted entry through its attestation and reports the count in a new `redacted` field. Scoping mirrors `trail()`: tenant-forced inside a context, `request.tenantId` outside one, and `audit.systemRedact()` for deliberate cross-tenant tooling. Redaction is refused (`AuditRedactionRefusedError`) for an entry that does not verify as it is, for a `residual` above the accepted level (the default `'keyed'` refuses unkeyed chains), and for a store without `get()`/`redact()`. `MemoryAuditStore` implements both.

Opt-in `integrity: { mode: 'hash-chain', erasable: true }` writes v3 hashes (`v3:sha256:` / `v3:hmac-sha256:<keyId>:`), which are v2 plus a random per-entry `nonce` that a redaction destroys, so the erased value can no longer be confirmed from the hash. With `erasable` off, entries are byte-identical to v2. Upgrade every verifier before the first redaction or before turning on `erasable`: older releases report those entries as `hash-mismatch`.

New exports: `AUDIT_ERASED`, `AUDIT_REDACTED_EVENT`, `auditRedactionState`, `computeAuditHashV3`, `AuditRedactionConflictError`, `AuditEntryNotFoundError`, `AuditRedactionRefusedError` and the related types. The `AuditStore` contract gains the optional `get()` and `redact()`, and `AuditEntry` gains the optional `nonce` and `redaction`.

Watch for:
- **Union widenings.** `AuditVerifyFailure` gains `'redaction-mismatch'` and `ParsedAuditHash` gains `version: 3` members. An exhaustive `switch` over either needs a new case.
- **Reserved event.** `record('audit:redacted', …)` now throws a `TypeError`. The `audit:` event prefix is reserved for framework events.
- **Custom stores** must round-trip `nonce` and `redaction`. A store without `get()` that holds a redacted entry fails `verify()` closed with `redaction-mismatch`.
