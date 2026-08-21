---
"@basaltkit/queue": minor
---

Add the `queue:work`, `queue:stats` and `queue:retry` CLI commands.

`queuePlugin` now registers three commands into the CLI command bucket:

- **`queue:work --queue --concurrency`** — run a worker until interrupted.
- **`queue:stats --queue`** — job counts (waiting/active/completed/failed/delayed).
- **`queue:retry --queue --limit`** — re-enqueue failed jobs.

Backed by an optional driver introspection surface (`QueueDriver.stats` / `retryFailed`, exposed via `QueueManager.stats()` / `retryFailed()`), implemented for the BullMQ driver. The inline sync driver keeps no job state, so `stats`/`retry` report the operation as unsupported instead of guessing.
