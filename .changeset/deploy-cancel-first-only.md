---
'@basaltkit/deploy': minor
---

`cancel <runId> --first-only` (RFC 0008 §8.5): sends only a first signal. When the run was already cancelled once, from any client (the `<runId>.cancel` marker on the server says so), it is refused with the new protocol error code `already-cancelled` (exit 1) and nothing is signalled. A client that asked for the mild cancel, which stops at a step boundary, therefore never sends the immediate one by surprise. Additive: a plain `cancel` behaves as before.
