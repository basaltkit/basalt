---
"@basaltkit/drives": patch
---

`createDriveFetch` is now a thin wrapper over `@basaltkit/webhooks`' public `createGuardedFetch` (no behaviour change: same allowlist, SSRF guard, pinning, redirect, cap, timeout and rate-limit handling, same `DRIVE_*` errors). `GuardedResponse` gains `arrayBuffer()`; `hostAllowed` is re-exported from `@basaltkit/webhooks`.
