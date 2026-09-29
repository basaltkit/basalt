---
'@basaltkit/http': minor
'@basaltkit/mcp': major
---

**Error details are public by construction (FA-H05 / BK-050).** `HttpError.details` reached HTTP clients — and, through `@basaltkit/mcp`, the language model in every `isError` tool result — verbatim: sanitised for shape and size, never for sensitivity.

`@basaltkit/http` (minor, additive — HTTP output is unchanged):

- `new HttpError(status, code, message, { internalDetails })` — a log-only channel. The error reporter receives it (the default reporter logs it as an `internalDetails` field, 4xx and 5xx); it is never serialised into a response body or a tool result, and is non-enumerable on the error. `internalDetailsOf(error)` reads it (sanitised) for custom reporters; any error may define the property.
- `toErrorResponse(error, { redactDetails })` — an optional `ErrorDetailsRedactor` that filters the public `details` (output re-sanitised; a throwing redactor sends none). The adapters pass none.
- `redactSensitiveDetails`, `isSensitiveDetailsKey`, `REDACTED_DETAIL`, `applyDetailsRedactor` — the stock redactor: anchored, segment-aware sensitive-key matching (kept in step with `@basaltkit/audit`'s `isSensitiveKey`, copied rather than depended on) that masks the values of keys such as `password`, `resetToken`, `apiKey`, `secret`, `sessionId`; booleans and `null` are kept.

`@basaltkit/mcp` (major — the default changes what an MCP client sees):

- A thrown error's `details` now pass through `redactSensitiveDetails` before entering a tool result, so a value under a secret-named key reaches the model as `'[REDACTED]'` instead of verbatim. Configure with `mcpPlugin({ redactErrorDetails })` (also `McpServer`/`collectTools`), or per route with `meta.mcp: { redactErrorDetails }`; `false` restores the previous verbatim output.
- Tool-call errors are now reported: `mcpPlugin({ reportError })` receives each thrown error with its `internalDetails` (default: the console reporter the Express/Hono adapters use — 5xx to `console.error`, 4xx to `console.warn`). They used to vanish silently. `false` restores the old silence.

Migration: nothing to do unless a tool's client relied on a secret-named key in `details` (it should not) — pass `redactErrorDetails: false` or your own redactor, and move operator-only data to `internalDetails`.
