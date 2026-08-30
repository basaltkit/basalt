---
'@basaltkit/audit': minor
---

The redactors truncate past their depth limit instead of passing the raw subtree through.

Both `redactSensitive` and `redactSensitiveAndPii` stopped at depth 6 by returning the value **unchanged**. Audit payloads are arbitrary and the default subscription is `events: ['**']`, so a `password` nested seven levels deep was persisted to the trail in cleartext — verified. Objects past the bound now become `'[truncated]'`; primitives (whose keys were already checked one level up) are unaffected, so nothing within the limit changes.

Also adds `exactEventMatch()` and `AUDIT_SCAN_PAGE`, the shared helpers the store drivers use to push a query's limit down into the database.
