---
'@machize/queue-rabbitmq': patch
'@machize/queue-kafka': patch
'@machize/queue-sqs': patch
---

Add package READMEs. The three queue-driver packages were published without a README (npm showed "This package does not have a README"). Each now documents installation (including the peer dependency), a quick start, how the backend maps retries/backoff/delay and dead-lettering, its honest capability profile, and an options reference.
