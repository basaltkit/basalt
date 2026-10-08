---
'@basaltkit/http': minor
'@basaltkit/mcp': patch
---

Per-route rate limits without a resolved client IP (BK-046).

- `@basaltkit/http`: when `request.ip` is unresolved (Hono without `getClientIp`, a hand-built `runRoute`, an MCP tool called over stdio or through `McpServer.callTool`), the `meta.rateLimit` guard now keys an identified caller by `user:<id>|tenant:<id>` instead of putting everyone in the shared `unknown` bucket. Anonymous ip-less requests still share the fail-closed `unknown` bucket, and requests with an IP are keyed exactly as before.
- `@basaltkit/http`: `securityPlugin({ rateLimit })` claims `meta.rateLimit` (new `RATE_LIMIT_META_KEY` export). When routes declare `meta.rateLimit` and no limiter claims it, the adapters' boot check now prints one `console.warn` per app naming those routes. The boot is never refused. Silence the warning with `allowUnguardedMeta: ['rateLimit']` (or `true`).
- Docs: corrected the claim that an unresolved key "never" falls back to one shared bucket. The ip-less behaviour is now documented in the security, adapters and MCP guides (EN and PT) and in the package READMEs.
