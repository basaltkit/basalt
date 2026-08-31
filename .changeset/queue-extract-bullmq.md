---
'@basaltkit/queue': minor
---

## ⚠️ THIS MINOR CONTAINS A BREAKING CHANGE — READ BEFORE UPGRADING

**Released as a minor deliberately, by the package owner, because the framework
had no external adopters at the time.** Semver would normally make this a major.
If you are on `^2.0.0` you will receive it automatically, so upgrade with this
note in hand rather than on autopilot.

**`queuePlugin({ connection })` no longer exists.** The BullMQ driver has moved
out of this package into `@basaltkit/queue-bullmq`, leaving the core a pure
driver contract with no knowledge of any backend.

### What was removed

| Removed | Replacement |
| --- | --- |
| `queuePlugin({ connection })` | `bullmqQueuePlugin({ connection })` from `@basaltkit/queue-bullmq` |
| `queuePlugin({ onError, onJobFailed })` | the same keys on `bullmqQueuePlugin` |
| `@basaltkit/queue/bullmq` subpath | `@basaltkit/queue-bullmq` |
| `BullmqDriverOptions` type export | re-exported from `@basaltkit/queue-bullmq` |
| `MissingQueueDriverPackageError` | gone — you now import the package you use, so there is no optional peer left to be missing |

### Migration

```bash
pnpm add @basaltkit/queue-bullmq
```

```diff
-import { queuePlugin } from '@basaltkit/queue'
+import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

-queuePlugin({ connection: process.env.REDIS_URL, jobs, workers })
+bullmqQueuePlugin({ connection: process.env.REDIS_URL!, jobs, workers })
```

Nothing else changes: `defineJob`, `dispatch`, workers, context propagation,
`QUEUE` and `QueueManager` are all untouched. If you were already passing an
explicit `driver`, or using the sync driver, **you are unaffected**.

### Why

2.0.0 made `bullmq` an optional peer, which stopped forcing the install — but
the core still carried the driver's source, a lazy-load cache, a subpath export
and a missing-package error, all of it complexity that existed only to work
around the structure. Extraction deletes all of it.

It also removes a DX asymmetry that predated the fix: BullMQ got
`connection: url` while RabbitMQ, SQS and Kafka wrote `driver: new X()`. Now
each backend ships an equivalent one-line plugin, and `queuePlugin` is what they
all wrap.

### Also in this release

- `RetentionOption` is now exported. Every driver package needs it to map the
  neutral retention onto its backend's vocabulary, making it part of the
  contract rather than an internal detail.
- `queuePlugin`'s `register` is synchronous again (the lazy driver import that
  made it async is gone).
- With no `driver`, the production warning now names the backend plugins.
