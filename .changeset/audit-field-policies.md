---
'@basaltkit/audit': minor
---

New `fieldPolicies` / `fieldPolicyKey` options (on `auditPlugin` and `new Audit(..., { ... })`): a per-event personal-data policy keyed by exact event or hook name. `omit` removes fields and `pseudonymize` replaces them with keyed HMAC pseudonyms (`pii_<hex>`, identical to `createPiiMinimizingRedactor` under the same key), by dotted path with arrays walked transparently. It runs before the redactor and before hashing, so omitted data never reaches the store or the hash chain. Policies are validated at configuration time. Events without a policy are unchanged.
