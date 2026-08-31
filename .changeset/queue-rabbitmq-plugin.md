---
'@basaltkit/queue-rabbitmq': minor
---

**New: `rabbitmqQueuePlugin`** — the one-line way to register this backend,
matching `bullmqQueuePlugin` and the other satellites so no backend is
privileged in the core's API.

```diff
-import { queuePlugin } from '@basaltkit/queue'
-import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'
+import { rabbitmqQueuePlugin } from '@basaltkit/queue-rabbitmq'

-queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })
+rabbitmqQueuePlugin({ url: process.env.AMQP_URL!, jobs, workers })
```

It accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
`removeOnComplete`, `removeOnFail`) alongside this driver's own options, and
splits them by the *core's* keys — so a driver option added later flows through
untouched.

Purely additive: `RabbitmqQueueDriver` is still exported and
`queuePlugin({ driver })` still works.
