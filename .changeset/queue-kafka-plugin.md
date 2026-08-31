---
'@basaltkit/queue-kafka': minor
---

**New: `kafkaQueuePlugin`** — the one-line way to register this backend,
matching `bullmqQueuePlugin` and the other satellites so no backend is
privileged in the core's API.

```diff
-import { queuePlugin } from '@basaltkit/queue'
-import { KafkaQueueDriver } from '@basaltkit/queue-kafka'
+import { kafkaQueuePlugin } from '@basaltkit/queue-kafka'

-queuePlugin({ driver: new KafkaQueueDriver({ brokers: ['localhost:9092'] }), jobs, workers })
+kafkaQueuePlugin({ brokers: ['localhost:9092'], jobs, workers })
```

It accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
`removeOnComplete`, `removeOnFail`) alongside this driver's own options, and
splits them by the *core's* keys — so a driver option added later flows through
untouched.

Purely additive: `KafkaQueueDriver` is still exported and
`queuePlugin({ driver })` still works.
