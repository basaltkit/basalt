---
"@basaltkit/queue-kafka": minor
---

**Infrastructure faults are now observable (`onError`) instead of process-fatal or silent — the same pattern as the rabbitmq/sqs drivers.**

- `startWorker` was a floating `void (async …)()`: a broker connect/subscribe/run failure at boot became an **unhandled rejection** (process-fatal by Node's default) — or, caught by nothing, an app that reports healthy with **zero workers**. It now surfaces through the new `onError` option (`(error, { source: 'consumer' | 'producer', queue })`, default: contextual `console.error`).
- A failed retry/dead-letter **re-publish** inside the consume callback used to throw raw into the consumer. It now reports through `onError` and then rethrows deliberately, so the offset is **not** committed and Kafka redelivers the message — a producer outage can no longer silently lose a failing job (the Kafka equivalent of rabbitmq's keep-unacked).
