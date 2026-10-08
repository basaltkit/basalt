---
"@basaltkit/tenancy": minor
---

`tenancy.run()` now emits `tenancy:exited` `{ tenant }` when its callback settles — resolved or thrown — still inside the tenant context, so a `tenancy:switched` listener can release what it took (BK-077). `tenancy:switched` gains an optional `via: 'run' | 'http'` telling `tenancy.run()` apart from the HTTP request enricher. A failing `tenancy:exited` listener never masks the callback's own error. Additive.
