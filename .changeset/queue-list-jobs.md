---
'@basaltkit/queue': minor
---

Add `list()` — the supported way to inspect **which** jobs are on a queue.

`QueueDriver` gains an optional `list(queue, { states?, limit? })`, alongside the
existing optional `stats()` / `retryFailed()`, and `QueueManager.list()` mirrors
them: `undefined` when the driver can't do it, so callers get an honest
"unsupported" instead of a guess. Implemented by the **BullMQ** driver (Redis
keeps jobs, so reading is non-destructive).

Results are driver-neutral `JobSummary` objects — `{ id, name, state,
attemptsMade, timestamp, payload, context?, failedReason? }` — never the
backend's own job type, and with `payload` already unwrapped from the
`{ payload, context }` dispatch envelope. Defaults: states
`['completed', 'failed', 'waiting', 'active']` (a healthy queue has
`waiting`/`active` empty, so defaulting to only those would report "no jobs" on a
queue that is working) and `limit` 20 in total, newest first, capped at 1000.

New CLI command `basalt queue:jobs --queue --states --limit [--payload]`,
alongside `queue:stats` / `queue:retry`. **Payloads are hidden unless `--payload`
is passed** — a job payload can carry personal data.

Also exported for custom drivers: `JobState`, `JobSummary`, `JobEnvelope`,
`ListJobsOptions`, `readJobEnvelope`, `DEFAULT_LIST_STATES`,
`DEFAULT_LIST_LIMIT`, `MAX_LIST_LIMIT`. No breaking change: `list` is optional
and existing drivers keep working unchanged.
