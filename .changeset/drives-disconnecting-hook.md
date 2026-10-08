---
"@basaltkit/drives": minor
---

`disconnect()` now emits a `drive:disconnecting` hook before anything is revoked or deleted, while the row still exists. A throwing handler vetoes the disconnect (no revoke, row kept, error propagated); `disconnect(id, { force: true })` proceeds anyway and reports the handler's error to the new `onHookError` option (`process.emitWarning` by default). The fixed order — disconnecting → revoke → unwatch → delete → disconnected — is now documented.
