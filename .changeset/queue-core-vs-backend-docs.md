---
'@basaltkit/queue': patch
---

Docs: make it explicit that `@basaltkit/queue` is required whichever backend you
pick.

The install table listed `Sync (dev/test) | @basaltkit/queue` as one row among
the backends, which reads as "pick one" — so the core looked like an *option*
rather than the contract every backend implements. A maintainer following it
after the BullMQ extraction asked, reasonably, whether `@basaltkit/queue` was
still needed at all.

It is: `defineJob`, `dispatch`, the `QUEUE` token, `QueueManager`, workers and
context propagation all live there, and a backend package **depends on** it
rather than replacing it. Adding one chooses where jobs run; it does not swap
libraries.

The guide and the README now split "what comes from the core" from "what comes
from a backend" before the table, and the sync row reads **none — inline,
dev/tests** instead of naming the core as if it were a backend.

Docs only — no code change.
