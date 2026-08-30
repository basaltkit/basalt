---
'@basaltkit/queue': major
---

**BREAKING — `bullmq` is now an optional peer dependency, not a dependency.**

**Remedy (one line):** if your app passes `queuePlugin({ connection })` or uses
`BullmqQueueDriver`, run `pnpm add bullmq` (`^6.2.1`). Nothing else changes.
Apps on RabbitMQ/SQS/Kafka or the sync driver need no action — and stop
installing BullMQ (plus its ioredis transitive weight) altogether.

**What was wrong.** `@basaltkit/queue` is the *driver-agnostic* core, yet it
declared `bullmq` in `dependencies` and its barrel statically re-exported
`drivers/bullmq.js`, which imports `bullmq` at module scope. Every consumer
therefore installed **and loaded** BullMQ, whichever backend they actually ran
on. This was historical, not intentional: BullMQ predates the
`@basaltkit/queue-rabbitmq` / `-sqs` / `-kafka` satellites — which all correctly
declare their client as a peer — and nobody realigned it when they arrived.

**What changed.**

- `bullmq` moved to `peerDependencies` with
  `peerDependenciesMeta: { bullmq: { optional: true } }`.
- The barrel no longer pulls the driver. `queuePlugin({ connection })` resolves
  `drivers/bullmq.js` with a cached `await import()` during the plugin's
  `register` phase (which `BasaltApp.boot()` already awaits — the lifecycle
  contract is unchanged). Registration still opens no connection: the driver is
  constructed, and Redis first touched, when `QUEUE` is resolved, exactly as
  before.
- `BullmqQueueDriver` now has its **own entry point**, matching the one-import-
  path-per-backend shape of the driver packages:

  ```diff
  - import { queuePlugin, BullmqQueueDriver } from '@basaltkit/queue'
  + import { queuePlugin } from '@basaltkit/queue'
  + import { BullmqQueueDriver } from '@basaltkit/queue/bullmq'
  ```

  The `BullmqDriverOptions` **type** is still exported from `@basaltkit/queue`
  (types are erased at build, so they cost a consumer nothing).
- Selecting BullMQ without the peer installed now throws
  `MissingQueueDriverPackageError` (`QUEUE_MISSING_DRIVER_PACKAGE`) at boot,
  naming the fix and the alternatives, with the original resolution failure kept
  as `.cause` — instead of a bare `ERR_MODULE_NOT_FOUND` from inside the driver.

**Guarded against regression** by two new tests in this package:
`tests/lazy-bullmq.test.ts` (a `bullmq` mock factory that must not be evaluated
when the barrel is imported or the sync path boots) and
`tests/driver-boundary.test.ts` — a repo-wide structural rule, modeled on the
existing adapter- and SaaS-boundary tests, that no package may force a concrete
backend client onto its consumers, nor reach one through its main entry's static
import graph.
