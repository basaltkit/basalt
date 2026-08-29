---
"@basaltkit/queue-rabbitmq": minor
---

**Reliability (Q-7): publisher confirms before ack, graceful shutdown drain, and visible worker-boot failures.**

**What was exposed.** On handler failure the driver re-published the job to the retry/dead-letter queue on a plain channel and immediately `ack`ed the original — if that unconfirmed publish was lost (broker fault, closed channel), the ack had already destroyed the only durable copy: silent job loss. `close()` tore the channel down under in-flight handlers, whose acks then threw into the consume callback as fatal unhandled rejections; and `startWorker`'s fire-and-forget connect meant a broker-unreachable boot left the app "healthy" with zero workers.

**What changed.** The driver now prefers a publisher-confirm channel (`createConfirmChannel`, with fallback for connections that lack it) and awaits `waitForConfirms` after every publish — in `add()` before reporting the job dispatched, and in the failure path BEFORE acking, so the broker owns the re-routed copy first; if the confirm fails, nothing is acked and the broker redelivers (at-least-once, never silent loss). `close()` drains in-flight handlers with a deadline (new `drainTimeoutMs` option, default 10 s); messages arriving mid-shutdown are left unacked for redelivery. Worker-boot and ack/publish faults surface through `onError` instead of crashing. `AmqpChannel`/`AmqpConnection` gain optional `waitForConfirms`/`createConfirmChannel` members (additive; existing fakes keep working).
