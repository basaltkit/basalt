---
'@machize/queue': minor
---

Add driver capability checks so unsupported job options fail loudly instead of being silently dropped.

Backends differ — a driver may not honor delayed delivery, priority, retries, or retry backoff (Kafka has no message priority, a naive RabbitMQ setup has no delayed jobs, the sync driver runs inline). A driver now declares a `capabilities` object (`{ delayed, priority, retries, backoff }`), and the `QueueManager` checks each dispatch's options against it.

- New `DriverCapabilities` type; `QueueDriver` gains optional `name` and `capabilities`. `BullmqQueueDriver` declares full support; `SyncQueueDriver` declares `{ delayed: false, priority: false, retries: true, backoff: false }`.
- `queuePlugin({ onUnsupported })` / `new QueueManager(driver, { onUnsupported })` chooses the reaction: `'warn'` (default — logs once per job+feature, then proceeds), `'throw'` (raise `UnsupportedJobOptionError`, recommended in production), or `'ignore'` (legacy silent behavior).
- Back-compatible: a driver that omits `capabilities` is assumed fully capable, so existing custom drivers are unaffected. This is the seam a future `@machize/queue-rabbitmq` / `@machize/queue-kafka` driver plugs into.
