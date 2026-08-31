---
'@basaltkit/queue-sqs': minor
---

**New: `sqsQueuePlugin`** — the one-line way to register this backend,
matching `bullmqQueuePlugin` and the other satellites so no backend is
privileged in the core's API.

```diff
-import { queuePlugin } from '@basaltkit/queue'
-import { SqsQueueDriver } from '@basaltkit/queue-sqs'
+import { sqsQueuePlugin } from '@basaltkit/queue-sqs'

-queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => URLS[q]! }), jobs, workers })
+sqsQueuePlugin({ region: 'eu-west-1', queueUrl: (q) => URLS[q]!, jobs, workers })
```

It accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
`removeOnComplete`, `removeOnFail`) alongside this driver's own options, and
splits them by the *core's* keys — so a driver option added later flows through
untouched.

Purely additive: `SqsQueueDriver` is still exported and
`queuePlugin({ driver })` still works.
