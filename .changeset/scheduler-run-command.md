---
"@basaltkit/scheduler": minor
---

Add the `schedule:run` CLI command and `Scheduler.runNow`.

- **`schedule:run <name>`** runs a scheduled task on demand, ignoring its cron; **`schedule:run --due`** runs everything due at this instant (a manual tick). Registered by `schedulerPlugin` into the CLI command bucket, executed against the live `Scheduler` (so overlap guards and `onFailure` handlers still apply).
- New `Scheduler.runNow(name)` (returns false for an unknown entry) and `Scheduler.names()`.

Completes the `basalt schedule list|run` surface from the RFC.
