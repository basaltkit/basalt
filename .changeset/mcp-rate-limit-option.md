---
"@basaltkit/mcp": minor
---

**`mcpRoutes({ rateLimit })` — a dedicated budget for the MCP endpoint (A-2, minimal).** Re-verification showed the original amplification premise no longer holds: `handleMessage` processes exactly one JSON-RPC message per HTTP request (no batching), so the per-request limiter counts tool calls 1:1. The real residual is that a tool route's own `meta.rateLimit` belongs to its direct HTTP registration and is NOT applied when the route is invoked as a tool through `/mcp`. The new option stamps `meta.rateLimit` on the `/mcp` route so `securityPlugin` enforces a dedicated, stricter budget for tool traffic; documented in the MCP guide (EN+PT). No bespoke limiter was built — this reuses the existing per-route override mechanism.
