# @basaltkit/mcp

## 5.1.0

### Minor Changes

- f29b366: Reject malformed MCP `arguments` and stop echoing internal exception text (BK-047).
  
  - `@basaltkit/mcp-core`: `tools/call` now refuses a present-but-non-object `arguments` (array, string, number, `null`) with `INVALID_PARAMS` before the tool runs, and `prompts/get` requires an object of string values. An unexpected throw from a tool, resource or prompt now answers `INTERNAL_ERROR` with the generic text `Internal error` instead of the exception's `message` (which could carry secrets, paths or SQL). An error with `expose: true` keeps its message. The new `McpServerOptions.onError(error, message)` hook receives the original error for logging. Clients that parsed the `-32603` message text will now see `Internal error`.
  - `@basaltkit/mcp`: building the route request from tool arguments (argument splitting, URL filling) now runs inside the tool's error handling, so a failure there ends as a sanitised `isError` result instead of a raw `TypeError` text. New `onError` option on `mcpPlugin` / `McpServer` (and exported `reportMcpInternalError`, the default): an error that escapes a tool's own handling — the client sees only `Internal error` — is written as one line to stderr (never stdout, which carries the stdio protocol). Pass your own hook, or `false` to silence it. A tool call never forwards the idempotency key (`idempotency-key`, or the header `idempotencyPlugin({ header })` configured) into the route pipeline, even when it is listed in `forwardHeaders`: an idempotent replay returns the recorded response verbatim, so a replayed error would have reached the model with its `details` unredacted. Each tool call runs the handler; an app that listed the key to deduplicate tool calls must deduplicate inside the handler instead.
  - `@basaltkit/ai-mcp`: new `onError` option on `AiMcpOptions`; the `basalt-ai-mcp` bin logs the real cause of an internal error to stderr.

### Patch Changes

- eeb90bb: Per-route rate limits without a resolved client IP (BK-046).
  
  - `@basaltkit/http`: when `request.ip` is unresolved (Hono without `getClientIp`, a hand-built `runRoute`, an MCP tool called over stdio or through `McpServer.callTool`), the `meta.rateLimit` guard now keys an identified caller by `user:<id>|tenant:<id>` instead of putting everyone in the shared `unknown` bucket. Anonymous ip-less requests still share the fail-closed `unknown` bucket, and requests with an IP are keyed exactly as before.
  - `@basaltkit/http`: `securityPlugin({ rateLimit })` claims `meta.rateLimit` (new `RATE_LIMIT_META_KEY` export). When routes declare `meta.rateLimit` and no limiter claims it, the adapters' boot check now prints one `console.warn` per app naming those routes. The boot is never refused. Silence the warning with `allowUnguardedMeta: ['rateLimit']` (or `true`). Apps that mount `authRoutes()` without `securityPlugin({ rateLimit })` see it at boot, because the auth routes declare `meta.rateLimit` by default: register the limiter, or pass `authRoutes({ rateLimit: false })` / silence it.
  - Docs: corrected the claim that an unresolved key "never" falls back to one shared bucket. The ip-less behaviour is now documented in the security, adapters and MCP guides (EN and PT) and in the package READMEs.
- 500edef: A request disposer that fails during a tool call is reported through `reportError` (code `REQUEST_DISPOSER_FAILED`) instead of being dropped silently. Disposers still finish before the tool result is built; on a cancelled call they run once the abandoned handler has settled.
- 500edef: `@basaltkit/http` exports `idempotencyHeaderOf(container): string | undefined` — the request header `idempotencyPlugin` reads the key from, lower-cased (`'idempotency-key'` unless renamed with `idempotencyPlugin({ header })`), or `undefined` when the plugin is not registered. It reads the registration as it is now and caches nothing.
  
  `@basaltkit/mcp` now learns the idempotency header through this helper instead of reading `@basaltkit/http`'s internal metadata, so http can change how it stores the stage without breaking tool calls. Behaviour is unchanged: a tool call still never forwards `Idempotency-Key` (always dropped) or the configured custom header. `@basaltkit/http` stays a regular dependency of `@basaltkit/mcp` (not a peer); this release publishes the range as `^2.8.0`, the http minor that adds the helper, and npm installs both together — no peer-dependency change and nothing to do for apps.
- Updated dependencies [0353877]
- Updated dependencies [7a3fd88]
- Updated dependencies [eeb90bb]
- Updated dependencies [f29b366]
- Updated dependencies [e600b0a]
- Updated dependencies [e74b21b]
- Updated dependencies [3ce3446]
- Updated dependencies [f029638]
- Updated dependencies [3740447]
- Updated dependencies [8b76628]
- Updated dependencies [36b800c]
- Updated dependencies [500edef]
  - @basaltkit/http@2.8.0
  - @basaltkit/core@1.6.0
  - @basaltkit/mcp-core@0.5.0

## 5.0.0

### Major Changes

- b7171e5: **Error details are public by construction (FA-H05 / BK-050).** `HttpError.details` reached HTTP clients — and, through `@basaltkit/mcp`, the language model in every `isError` tool result — verbatim: sanitised for shape and size, never for sensitivity.
  
  `@basaltkit/http` (minor, additive — HTTP output is unchanged):
  
  - `new HttpError(status, code, message, { internalDetails })` — a log-only channel. The error reporter receives it (the default reporter logs it as an `internalDetails` field, 4xx and 5xx); it is never serialised into a response body or a tool result, and is non-enumerable on the error. `internalDetailsOf(error)` reads it (sanitised) for custom reporters; any error may define the property.
  - `toErrorResponse(error, { redactDetails })` — an optional `ErrorDetailsRedactor` that filters the public `details` (output re-sanitised; a throwing redactor sends none). The adapters pass none.
  - `redactSensitiveDetails`, `isSensitiveDetailsKey`, `REDACTED_DETAIL`, `applyDetailsRedactor` — the stock redactor: anchored, segment-aware sensitive-key matching (kept in step with `@basaltkit/audit`'s `isSensitiveKey`, copied rather than depended on) that masks the values of keys such as `password`, `resetToken`, `apiKey`, `secret`, `sessionId`; booleans and `null` are kept.
  
  `@basaltkit/mcp` (major — the default changes what an MCP client sees):
  
  - A thrown error's `details` now pass through `redactSensitiveDetails` before entering a tool result, so a value under a secret-named key reaches the model as `'[REDACTED]'` instead of verbatim. Configure with `mcpPlugin({ redactErrorDetails })` (also `McpServer`/`collectTools`), or per route with `meta.mcp: { redactErrorDetails }`; `false` restores the previous verbatim output.
  - Tool-call errors are now reported: `mcpPlugin({ reportError })` receives each thrown error with its `internalDetails` (default: the console reporter the Express/Hono adapters use — 5xx to `console.error`, 4xx to `console.warn`). They used to vanish silently. `false` restores the old silence.
  
  Migration: nothing to do unless a tool's client relied on a secret-named key in `details` (it should not) — pass `redactErrorDetails: false` or your own redactor, and move operator-only data to `internalDetails`.

### Patch Changes

- Updated dependencies [b7171e5]
  - @basaltkit/http@2.7.0

## 4.0.0

### Major Changes

- e54b7b1: Harden the runtime MCP surface (framework audit FA-034 – FA-038).
  
  **Breaking** (hence major — each changes a default a caller may rely on):
  
  - `POST /mcp` now answers **403** to a request whose `Origin` header is neither
    same-origin nor listed in the new `mcpRoutes({ allowedOrigins })` (`'*'`
    disables the check), and **415** unless the body is sent as
    `application/json`. Non-browser MCP clients send no `Origin` and are
    unaffected; a browser-hosted client on another origin must be allow-listed.
  - A tool call no longer inherits every header of the `/mcp` request. It gets
    an allowlist — `DEFAULT_FORWARDED_HEADERS` (`authorization`, `cookie`,
    `x-api-key`, `x-tenant-id`, `host`, `accept-language`, `user-agent`) — and
    `mcpPlugin({ forwardHeaders })` extends it. `x-request-id`, `if-none-match`,
    forwarding and hop-by-hop headers are dropped. The same filter applies to
    `McpServer.callTool(name, args, { headers })`.
  - A handler that replies `reply.code(status)` with `status >= 400` now yields a
    tool result with `isError: true` (it used to arrive as a success).
  
  **Fixes / additions:**
  
  - The synthetic tool request carries the caller's `ip` (`ToolCallContext.ip`;
    the `/mcp` route passes `request.ip`), `routePattern` (the tool route's
    template) and the concrete `url` built from the arguments (encoded params +
    query string) instead of the route template.
  - Cancellation reaches route-backed tools: the abort signal is passed through,
    the call answers "cancelled" (`isError`) as soon as it fires, and a handler
    can observe it with the new `toolSignal(request)`.
  - `mcpRoutes({ auth: true })` sets `meta.auth` on the endpoint so even
    `initialize`/`tools/list` require an authenticated caller; `mcpRoutes({ meta })`
    adds any other guard key.
  - `/mcp` accepts JSON-RPC batches; each POST is its own MCP session, so a
    cancel from one caller never reaches another's request.
- b69ea05: `/mcp` sessions (cross-POST cancellation) and a filtered `tools/list` (framework audit FA-037 / FA-035 residuals).
  
  **Breaking** (defaults change):
  
  - **Sessions on by default.** `mcpRoutes()` issues an `Mcp-Session-Id` on a successful `initialize` and requires it on every later POST — **400** without it, **404** for an unknown, expired or foreign session (spec clients then re-initialize). A session is bound to the caller that opened it (`ctx().user` + tenant; anonymous: a keyed fingerprint of `Authorization`), expires after 30 min idle and at most 1000 live at once (least recently used evicted) — `mcpRoutes({ sessions: { ttlMs, maxSessions } })`. A `notifications/cancelled` in a later POST of the **same** session now cancels the call it names; another session never can. A `DELETE` route on the same path ends a session. In-memory per process: use sticky sessions behind replicas, or `mcpRoutes({ sessions: false })` for the old stateless behaviour. Browser clients on another origin need `Mcp-Session-Id` in CORS `exposeHeaders`.
  - **`tools/list` hides what the caller cannot use** (`mcpRoutes({ listVisibleOnly })`, default `true`), using only side-effect-free checks — no guard runs, so no rate-limit consumption, audit or denial records: `meta.auth` tools are hidden from anonymous callers (when a guard claims `auth`), and any key whose plugin registers an `http:route-visibility` check (`teamsPlugin` → `meta.teamRole`, `permissionsPlugin` → `meta.can`). Not filtered: `mfa`, `scopes`, `subscribed`/`feature`, audiences, rate limits, handler-level checks. `tools/call` is unchanged — every guard still runs.
  
  **Additions:** `HttpClientTransport` keeps the session id (`sessionId`), sends it on every request and ends the session on `close()`; `serveMcpStdio` accepts `maxConcurrentRequests` (default 16) and `maxLineLength`; `McpTool.visible(context)`; re-exports `MCP_SESSION_HEADER` and `McpSessionOptions`.
- e53db52: `StdioClientTransport` no longer crashes the host or hangs forever (framework audit, Melhorias 8).
  
  - A command that can't be spawned (`ENOENT`) emitted an unhandled `'error'` on the child process, which took down the host at boot (`mcpClientPlugin` with a mistyped command). Spawn errors, a server that exits, and `EPIPE` on its stdin now reject the calls in flight with a clear error, and the next call spawns the server again.
  - New `timeoutMs` option (default 60 000 ms): a request the server never answers rejects instead of staying pending forever. Raise it for tools that legitimately run longer.

### Patch Changes

- Updated dependencies [e54b7b1]
- Updated dependencies [e54b7b1]
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
- Updated dependencies [e54b7b1]
- Updated dependencies [e53db52]
- Updated dependencies [b69ea05]
  - @basaltkit/core@1.5.0
  - @basaltkit/http@2.6.0
  - @basaltkit/mcp-core@0.4.0

## 3.0.0

### Major Changes

- fb85c40: Security: the stdio MCP client no longer passes the host's full `process.env` (APP_SECRET, DATABASE_URL, provider keys) to spawned MCP servers. By default only a non-secret allowlist (`DEFAULT_INHERITED_ENV`: PATH, HOME, locale, temp dirs and Windows basics) is inherited, plus the explicit `env`. Use `inheritEnv: ['NAME', …]` to pass extra variables, or `inheritEnv: true` to opt back in to the full environment. New export `buildStdioEnv`.

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/http@2.1.0

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1
  - @basaltkit/mcp-core@0.3.1

## 1.1.0

### Minor Changes

- cc4786e: **`mcpRoutes({ rateLimit })` — a dedicated budget for the MCP endpoint (A-2, minimal).** Re-verification showed the original amplification premise no longer holds: `handleMessage` processes exactly one JSON-RPC message per HTTP request (no batching), so the per-request limiter counts tool calls 1:1. The real residual is that a tool route's own `meta.rateLimit` belongs to its direct HTTP registration and is NOT applied when the route is invoked as a tool through `/mcp`. The new option stamps `meta.rateLimit` on the `/mcp` route so `securityPlugin` enforces a dedicated, stricter budget for tool traffic; documented in the MCP guide (EN+PT). No bespoke limiter was built — this reuses the existing per-route override mechanism.

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/http@1.11.0

## 1.0.3

### Patch Changes

- Updated dependencies [f197518]
  - @basaltkit/mcp-core@0.3.0

## 1.0.2

### Patch Changes

- 552cbe8: MCP foundations (RFC 0001 M0): extract a zero-dependency `@basaltkit/mcp-core` and grow the AI data contracts.
  
  - **New `@basaltkit/mcp-core`** (zero runtime dependencies): the JSON-RPC 2.0 + MCP wire protocol, a transport-neutral `McpServer` that dispatches over function-shaped tools/resources/prompts (with `AbortSignal` cancellation and progress plumbing), and a stdio transport. This is the shared wire that lets the runtime MCP surface and the forthcoming dev-only AI bridge reuse one protocol implementation without dragging the framework runtime into a developer's toolchain.
  - **`@basaltkit/mcp`** now builds its route-tools on top of `@basaltkit/mcp-core`. Public API and behaviour are unchanged (patch); the wire dispatch is delegated to the shared core.
  - **`@basaltkit/ai`** exports runtime `zod` schemas and a `toJsonSchema()` for its public data contracts (`ArchitecturePlan`, `MakeResult`, `AnalysisReport`, `ProjectContext`, `AgentReview`) — also available at the `@basaltkit/ai/schema` subpath. `parsePlan`/`parseReview` now validate their coerced output against these schemas, and `ArchitecturePlan`/`MakeResult` carry a `schemaVersion` for cross-process round-trips. Adds `zod` as a dependency of this dev-only package.
- Updated dependencies [552cbe8]
  - @basaltkit/mcp-core@0.2.0

## 0.2.3

### Patch Changes

- d41d1c7: Support Zod 4 when reading route schemas for tools. Object shapes (`_def.shape`
  is now a plain object, not a function) and scalar types (`_def.type` instead of
  `_def.typeName`) changed in v4, which broke tool argument splitting and the
  string→number/boolean coercion. Introspection is now version-agnostic.
- Updated dependencies [d41d1c7]
  - @basaltkit/http@1.5.1

## 0.2.2

### Patch Changes

- 3824868: Coerce stringified tool arguments to the scalar types their Zod schema declares.
  MCP clients/LLMs frequently send numbers and booleans as strings; the bridge now
  converts them (string → number/boolean) before validation, so routes with
  `z.number()`/`z.boolean()` fields no longer reject with "expected number,
  received string".

## 0.2.1

### Patch Changes

- 99bfe5d: Fix `tools/call` results for handlers that return a top-level array or primitive:
  `structuredContent` is now only set when the value is a JSON object (a record),
  per the MCP spec. Arrays/primitives ride in the text `content` only (with the
  full JSON), so clients no longer reject the result with "expected record,
  received array".

## 0.2.0

### Minor Changes

- e006b4b: New package `@basaltkit/mcp` — Model Context Protocol for Basalt. Expose opt-in
  routes (`meta.mcp`) as MCP tools over HTTP (`mcpRoutes()`, any adapter) or stdio
  (`serveMcpStdio()`), and consume external MCP servers as a client — either directly (`McpClient` with
  HTTP/stdio transports) or via `mcpClientPlugin({ servers })`, which registers a
  `MCP_CLIENTS` registry (connects at boot, closes on shutdown). Tool calls run through the neutral request pipeline,
  so validation, tenancy and auth apply exactly as over HTTP. Runtime package,
  independent of the dev-only `@basaltkit/ai` layer; no external SDK.

## 0.2.0

### Minor Changes

- 0cec7c3: New package `@basaltkit/mcp` — Model Context Protocol for Basalt. Expose opt-in
  routes (`meta.mcp`) as MCP tools over HTTP (`mcpRoutes()`, any adapter) or stdio
  (`serveMcpStdio()`), and consume external MCP servers as a client — either directly (`McpClient` with
  HTTP/stdio transports) or via `mcpClientPlugin({ servers })`, which registers a
  `MCP_CLIENTS` registry (connects at boot, closes on shutdown). Tool calls run through the neutral request pipeline,
  so validation, tenancy and auth apply exactly as over HTTP. Runtime package,
  independent of the dev-only `@basaltkit/ai` layer; no external SDK.
