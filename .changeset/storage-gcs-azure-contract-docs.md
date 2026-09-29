---
'@basaltkit/storage-gcs': patch
'@basaltkit/storage-azure': patch
---

Docs and tests for the `@basaltkit/storage` 5.0 contract: listed keys are scope-relative, and a streamed body that contradicts its `contentLength` is never finalized/committed. Both drivers already stream unknown-length bodies in bounded memory; the README says so.
