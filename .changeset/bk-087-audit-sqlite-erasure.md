---
'@basaltkit/audit-sqlite': minor
---

Supports `audit.redact()` (RFC 0003). `migrate()` adds the nullable `nonce`, `redaction` and `redacted_by` columns. The new `get(id)` reads one entry. `redact()` updates the row only while its `hash` and `redacted_by` are unchanged, and inserts the `audit:redacted` attestation, both inside one `BEGIN IMMEDIATE` transaction. A concurrent change maps to `AuditRedactionConflictError`, a `seq` race maps to `AuditChainConflictError`, and either one rolls the whole transaction back. v3 (`erasable`) entries persist their `nonce`, and a redaction clears it. The README has optional guard triggers that block `DELETE` and every update except a redaction. They guard against bugs, not attackers. Requires `@basaltkit/audit` 3.1.
