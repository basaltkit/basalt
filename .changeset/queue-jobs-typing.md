---
'@machize/queue': patch
---

`queuePlugin({ jobs })` now accepts typed jobs without a cast. The option was typed `JobDefinition<never>[]`, so a job carrying payload data (`defineJob<{ ... }>`) forced a `as JobDefinition<never>` cast; it is now `JobDefinition<unknown>[]`, which accepts both typed and untyped jobs.
