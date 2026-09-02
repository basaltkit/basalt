---
'@basaltkit/storage': major
---

## ⚠️ BREAKING — the S3 driver moved to `@basaltkit/storage-s3`

**Why:** `@basaltkit/storage` hard-depended on `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` — about **4.4 MB** — so *every* consumer
installed the AWS SDK. An app running only the local driver paid for it. An app
on Azure or GCS, whose driver packages already existed, paid for it too.

That is the same defect the queue had with BullMQ, and it is fixed the same way.

### Migration

```bash
pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```diff
+import { s3Disk } from '@basaltkit/storage-s3'

 storagePlugin({
   disks: {
     uploads: { driver: 'local', root: './storage' },
-    docs: { driver: 's3', bucket: 'my-app', region: 'eu-west-1' },
+    docs: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }),
   },
 })
```

`S3StorageDriver` and `S3DriverOptions` are re-exported from the new package, so
`{ driver: new S3StorageDriver(…) }` keeps working after changing the import.

**Unaffected:** apps using only `driver: 'local'`, or passing a driver instance
(`@basaltkit/storage-azure`, `-gcs`, or your own). `local` stays in the core — it
needs no client library, only `fs`.

### What this leaves behind

`DiskConfig` no longer has a `{ driver: 's3' }` member; `local` is the only
string left. `@basaltkit/storage` now depends on nothing but `@basaltkit/core`,
and the repo-wide driver-boundary tripwire no longer needs it in its allowlist —
the entry that recorded this as KNOWN DEBT is gone, because the debt is paid.
