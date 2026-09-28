---
"@basaltkit/mcp-core": minor
---

`serveHttp` transport fixes (framework audit FA-H23 and follow-ups).

- **Breaking (0.x minor):** `ctx.headers` keeps a repeated header's
  multiplicity — a header sent twice is a `string[]` of both values. It was
  built from `req.headers`, where Node joins most repeats with `, ` and keeps
  only the first `authorization`/`host`/`content-type`, so a tool could never
  refuse an ambiguous duplicated header. Headers sent once are still strings.
- `serveHttp({ host: '::1' })` returns a valid URL (`http://[::1]:port/mcp`); a
  bracketed `'[::1]'` is accepted too.
- `serveHttp` rejects with the `listen()` error (`EADDRINUSE`, …) instead of
  never settling and leaving an unhandled `'error'` event.
