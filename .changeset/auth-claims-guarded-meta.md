---
"@basaltkit/auth": patch
---

`authPlugin` claims `'auth'` in the `http:guarded-meta` bucket so the adapters' new boot check knows `meta.auth` is enforced. No API or behavior change in this package itself; apps that mount `meta.auth` routes *without* `authPlugin` now fail loud at boot (see the adapter releases).
