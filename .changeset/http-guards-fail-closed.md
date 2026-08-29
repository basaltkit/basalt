---
'@basaltkit/http': minor
---

A route pipeline that carries guards but no container now fails closed.

`runRoute` only ran enrichers and guards `if (scoped)` — with no container, every guard was **skipped silently** and the request reached the handler unauthorized. In practice guards and container arrive together (every shipped adapter wires both), so this was a fail-open *shape* rather than a live hole; it is now a `GuardsWithoutContainerError` (`HTTP_GUARDS_UNRUNNABLE`, 500) naming the route and the number of guards that could not run. A pipeline with no guards and no container — the common hand-rolled case — still runs untouched.
