---
'@basaltkit/queue-rabbitmq': patch
'@basaltkit/queue-sqs': patch
'@basaltkit/queue-kafka': patch
'@basaltkit/cli': patch
---

Document why these drivers deliberately omit the queue's new optional `list()`
capability (so `basalt queue:jobs` reports it as unsupported rather than faking
it): AMQP has no non-destructive read (`basic.get`/consume hide the message from
real workers and mark it redelivered); SQS's `ReceiveMessage` starts the
visibility timeout and bumps `ApproximateReceiveCount`, so peeking could redrive
jobs into the DLQ; and Kafka, while non-destructive to read, is a log with no
per-message state, so any job states would be invented. Looking at a queue must
never change it. The CLI README now lists `queue:jobs` among the plugin-registered
commands.
