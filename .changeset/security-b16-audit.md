---
'@basaltkit/audit': minor
'@basaltkit/audit-sqlite': patch
---

Security hardening for the audit trail:

- audit: `trail()`, `systemTrail()` and `MemoryAuditStore` reject a `limit` that is not a non-negative safe integer (new exported `assertAuditLimit`), so a request value forwarded unvalidated can never reach a store.
- audit-sqlite: `LIMIT`/`OFFSET` are bound parameters instead of being interpolated into the SQL, and the store validates `limit` itself.
- audit: PII pseudonyms are now HMAC-SHA256 with a configured key and 128-bit output (`createPiiMinimizingRedactor({ key })`, `pseudonymize(value, key)`); without a key a random per-process key is used and a warning is logged, so pseudonyms are no longer reversible by brute force. Pseudonyms change format and do not match those written by earlier versions.
- audit: every value under a PII key is pseudonymized whatever its shape (a numeric phone, a list of phones, a nested `{ number }` object); before, only a plain string was, so the others reached the trail raw. A pseudonymization key that is not a string or a `Uint8Array` is rejected when the redactor is created.
