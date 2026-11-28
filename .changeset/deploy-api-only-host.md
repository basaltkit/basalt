---
"@basaltkit/deploy": minor
---

**An API on its own host, with a managed proxy.** `caddy({ apiPrefix: '' })` and `apache({ apiPrefix: '' })` now mean that the whole host is the API: every path goes to the app as is, and no web root is served (no `DocumentRoot`, no `file_server`). Managed mode used to refuse `''`, so an API on `api.example.com` either answered only under `/api` behind a web root with nothing built into it, or gave up the managed proxy (`none()`, `managed: false`) along with its install, certificate and C1/C2 checks. Three apps had hit this.

`build.web` together with `apiPrefix: ''` is refused, because that web would never be served. `basalt-deploy init` writes `apiPrefix: ''` when the project has no web directory. Root's install accepts `''` in the plan. The output for prefixed proxies is unchanged byte for byte.
