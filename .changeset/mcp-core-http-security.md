---
"@basaltkit/mcp-core": minor
---

Harden the opt-in HTTP transport (`serveHttp`) against DNS-rebinding and CSRF.

Before dispatching any JSON-RPC/tool call, `serveHttp` now validates the request's `Host` and `Origin` headers, secure-by-default:

- **Host (anti-DNS-rebinding):** the `Host` hostname must be a loopback name (`localhost`, `127.0.0.1`, `::1`); a foreign `Host` (e.g. `evil.com`) is rejected with `403`.
- **Origin (anti-CSRF):** when an `Origin` header is present it must be a loopback origin; a foreign `Origin` is rejected with `403`. Requests with no `Origin` (curl, MCP-over-HTTP clients — browsers always send `Origin` on cross-site POST) are allowed.
- The check runs before routing, so a rejected request never reaches a tool.

New optional `ServeHttpOptions` (backward-compatible; default stays loopback-only): `allowedHosts?`, `allowedOrigins?`, and a full override `allowRequest?(origin, host)` — for when you deliberately bind a non-loopback `host` (e.g. `0.0.0.0` for remote/CI). These are threaded through `@basaltkit/ai-mcp`'s `createAiMcpHttpServer`. `serveHttp`'s signature is unchanged.
