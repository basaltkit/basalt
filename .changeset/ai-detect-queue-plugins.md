---
'@basaltkit/ai': patch
---

Detect the per-backend queue plugins (`bullmqQueuePlugin`,
`rabbitmqQueuePlugin`, `sqsQueuePlugin`, `kafkaQueuePlugin`) as evidence of the
`queue` capability.

Stack detection prefers the plugins actually wired in `app.ts`, and matched only
the core `queuePlugin` — so from now on it would have reported "no queue" for
every app that picked a real backend.
