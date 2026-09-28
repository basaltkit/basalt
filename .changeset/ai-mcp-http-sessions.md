---
'@basaltkit/ai-mcp': minor
---

`createAiMcpHttpServer` now passes `sessions` and `principal` through to `@basaltkit/mcp-core`'s `serveHttp` (they were accepted by the type but dropped), and the bin gains `--sessions` (with `--http`). With sessions on, `initialize` issues an `Mcp-Session-Id`, later requests must carry it (`400` without, `404` for an unknown, expired or foreign one), and a `notifications/cancelled` POSTed separately cancels the call it names — e.g. a long `basalt_make` — within the same session only. The default is unchanged: stateless, so existing header-less clients keep working.
