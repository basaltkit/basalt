---
"@basaltkit/drives": minor
---

Add `runDriveStoreContract()` on the test-only `@basaltkit/drives/testing` subpath: a runner-agnostic conformance suite for a durable `DriveConnectionStore` / `DriveImportLedger` (compare-and-set on `expectedRevision`, revision bump, `undefined` clears a column, tenant isolation, ledger idempotency). The docs no longer reference the non-existent `prismaDriveConnectionStore` / `prismaDriveImportLedger` factories; a new "Writing a durable store" guide section shows a Prisma reference implementation instead.
