---
"@basaltkit/queue": patch
---

**Sync (inline) driver: bounded memory and a loud production fallback (Q-6).** The driver's `executed[]` history grew unboundedly — a long-running process on the no-Redis default leaked memory forever; it is now capped at the most recent 1000 entries. And because the sync driver is the silent default when `connection` is unset, a production deploy that forgot `REDIS_URL` inverted queue semantics without a trace (at-most-once, handler errors rejecting `dispatch()` inside the request). `queuePlugin` now logs a boot warning when the sync driver is selected implicitly with `NODE_ENV=production`; pass `driver: new SyncQueueDriver()` to opt in deliberately. The inline/at-most-once/error-propagation semantics themselves are unchanged and now documented.
