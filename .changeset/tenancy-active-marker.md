---
"@basaltkit/tenancy": patch
---

`tenancyPlugin` adds a `tenancy:active` entry to the metadata registry — a string-keyed marker other plugins read to adopt tenant-safe defaults (first consumer: `@basaltkit/cache`, which now fails closed on a missing tenant scope in multi-tenant apps). No behavior change in this package.
