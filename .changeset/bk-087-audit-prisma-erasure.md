---
'@basaltkit/audit-prisma': minor
---

Supports `audit.redact()` (RFC 0003). Both schemas gain the nullable `nonce`, `redaction` and `redactedBy` columns, and `auditMysqlColumnLimits` covers them. You only need the migration when you redact or turn on `erasable`: `nonce` is sent only by v3 entries, so an existing schema keeps appending. `get(id)` validates the id before `findUnique`. `redact()` runs inside one interactive `$transaction`, which does two things:
- an `updateMany` conditioned on `hash` and `redactedBy`, where a miss maps to `AuditRedactionConflictError`;
- the attestation `create`, where a unique violation maps to `AuditChainConflictError`.

A client without `updateMany` or `$transaction` is refused with `'unsupported-store'`; `get()` falls back to `findMany` when `findUnique` is absent. The README keeps the blanket `REVOKE UPDATE, DELETE, TRUNCATE` for the app role. It adds a dedicated `audit_eraser` role with column-level `UPDATE` and an optional guard trigger. Requires `@basaltkit/audit` 3.1.
