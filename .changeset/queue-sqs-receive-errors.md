---
"@basaltkit/queue-sqs": minor
---

**Receive errors are visible and paced (Q-8 pin).** A failing `ReceiveMessage` (bad credentials, deleted queue, network fault) was swallowed and retried immediately — a silent, CPU-burning hot spin with zero log output. The poller now reports each failure through the new `onError` option (default: `console.error` with the queue name) and pauses `errorPauseMs` (default 1 s) before retrying.
