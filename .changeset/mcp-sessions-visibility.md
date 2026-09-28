---
'@basaltkit/mcp': major
---

`/mcp` sessions (cross-POST cancellation) and a filtered `tools/list` (framework audit FA-037 / FA-035 residuals).

**Breaking** (defaults change):

- **Sessions on by default.** `mcpRoutes()` issues an `Mcp-Session-Id` on a successful `initialize` and requires it on every later POST — **400** without it, **404** for an unknown, expired or foreign session (spec clients then re-initialize). A session is bound to the caller that opened it (`ctx().user` + tenant; anonymous: a keyed fingerprint of `Authorization`), expires after 30 min idle and at most 1000 live at once (least recently used evicted) — `mcpRoutes({ sessions: { ttlMs, maxSessions } })`. A `notifications/cancelled` in a later POST of the **same** session now cancels the call it names; another session never can. A `DELETE` route on the same path ends a session. In-memory per process: use sticky sessions behind replicas, or `mcpRoutes({ sessions: false })` for the old stateless behaviour. Browser clients on another origin need `Mcp-Session-Id` in CORS `exposeHeaders`.
- **`tools/list` hides what the caller cannot use** (`mcpRoutes({ listVisibleOnly })`, default `true`), using only side-effect-free checks — no guard runs, so no rate-limit consumption, audit or denial records: `meta.auth` tools are hidden from anonymous callers (when a guard claims `auth`), and any key whose plugin registers an `http:route-visibility` check (`teamsPlugin` → `meta.teamRole`, `permissionsPlugin` → `meta.can`). Not filtered: `mfa`, `scopes`, `subscribed`/`feature`, audiences, rate limits, handler-level checks. `tools/call` is unchanged — every guard still runs.

**Additions:** `HttpClientTransport` keeps the session id (`sessionId`), sends it on every request and ends the session on `close()`; `serveMcpStdio` accepts `maxConcurrentRequests` (default 16) and `maxLineLength`; `McpTool.visible(context)`; re-exports `MCP_SESSION_HEADER` and `McpSessionOptions`.
