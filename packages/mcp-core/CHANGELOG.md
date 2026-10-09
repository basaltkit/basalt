# @basaltkit/mcp-core

## 0.5.0

### Minor Changes

- f29b366: Reject malformed MCP `arguments` and stop echoing internal exception text (BK-047).
  
  - `@basaltkit/mcp-core`: `tools/call` now refuses a present-but-non-object `arguments` (array, string, number, `null`) with `INVALID_PARAMS` before the tool runs, and `prompts/get` requires an object of string values. An unexpected throw from a tool, resource or prompt now answers `INTERNAL_ERROR` with the generic text `Internal error` instead of the exception's `message` (which could carry secrets, paths or SQL). An error with `expose: true` keeps its message. The new `McpServerOptions.onError(error, message)` hook receives the original error for logging. Clients that parsed the `-32603` message text will now see `Internal error`.
  - `@basaltkit/mcp`: building the route request from tool arguments (argument splitting, URL filling) now runs inside the tool's error handling, so a failure there ends as a sanitised `isError` result instead of a raw `TypeError` text. New `onError` option on `mcpPlugin` / `McpServer` (and exported `reportMcpInternalError`, the default): an error that escapes a tool's own handling — the client sees only `Internal error` — is written as one line to stderr (never stdout, which carries the stdio protocol). Pass your own hook, or `false` to silence it. A tool call never forwards the idempotency key (`idempotency-key`, or the header `idempotencyPlugin({ header })` configured) into the route pipeline, even when it is listed in `forwardHeaders`: an idempotent replay returns the recorded response verbatim, so a replayed error would have reached the model with its `details` unredacted. Each tool call runs the handler; an app that listed the key to deduplicate tool calls must deduplicate inside the handler instead.
  - `@basaltkit/ai-mcp`: new `onError` option on `AiMcpOptions`; the `basalt-ai-mcp` bin logs the real cause of an internal error to stderr.

## 0.4.0

### Minor Changes

- e54b7b1: Harden the MCP core and its transports (framework audit FA-037, FA-039, FA-040).
  Minor because the package is 0.x, where a minor is the breaking slot — three
  defaults change (marked **breaking**).
  
  - **Breaking:** a request method sent as a notification (no `id`, e.g. a
    `tools/call` without one) is no longer executed nor answered — JSON-RPC never
    answers a notification. JSON-RPC responses sent to the server are ignored.
  - In-flight calls are keyed by `(session, id)` (new `CallContext.session`):
    `notifications/cancelled` only aborts calls of the same session, so one client
    can no longer cancel another's request. Each stdio stream and each HTTP
    request is its own session; session-less embeddings keep one shared scope. A
    second in-flight request reusing an id in the same session is refused.
  - **Breaking:** `serveHttp` refuses to bind a non-loopback `host` unless
    `authorize` (new — e.g. a bearer-token check answering `401`) or
    `allowRequest` is set: the Host/Origin guard is a browser guard, not
    authentication. `allowRequest` also receives the raw request.
  - **Breaking:** `serveHttp` caps request bodies at `maxBodyBytes` (default
    1 MiB) and answers `413` without buffering the rest. It also aborts a call
    when its client disconnects and forwards the peer address as
    `ctx.remoteAddress`.
  - stdio: implements `elicitation/create` — when the client announced the
    `elicitation` capability in `initialize`, tools receive `ctx.elicit`, which
    resolves `true` only for an `accept` with `confirm: true`. Client responses
    are routed back instead of being answered with an error.
  - JSON-RPC batches are supported (as protocol revision 2025-03-26, which is
    advertised, requires) through the new `dispatchPayload`, used by every
    bundled transport.
  - stdio decodes input with a `StringDecoder` (a multibyte character split
    across chunks no longer becomes U+FFFD) and drops lines longer than
    `maxLineLength` (default 4 MiB) with a `-32600` error instead of buffering
    them without bound.
- e53db52: `serveHttp` transport fixes (framework audit FA-H23 and follow-ups).
  
  - **Breaking (0.x minor):** `ctx.headers` keeps a repeated header's
    multiplicity — a header sent twice is a `string[]` of both values. It was
    built from `req.headers`, where Node joins most repeats with `, ` and keeps
    only the first `authorization`/`host`/`content-type`, so a tool could never
    refuse an ambiguous duplicated header. Headers sent once are still strings.
  - `serveHttp({ host: '::1' })` returns a valid URL (`http://[::1]:port/mcp`); a
    bracketed `'[::1]'` is accepted too.
  - `serveHttp` rejects with the `listen()` error (`EADDRINUSE`, …) instead of
    never settling and leaving an unhandled `'error'` event.
- b69ea05: Cross-POST cancellation, stdio concurrency cap and tool visibility (framework audit FA-037 / FA-040 / FA-035 residuals). Minor because the package is 0.x — one default changes (marked **breaking**).
  
  - **Breaking — stdio concurrency cap.** `serveStdio` admits at most `maxConcurrentRequests` (new, default `DEFAULT_MAX_CONCURRENT_REQUESTS` = 16) requests in flight per connection; one more is answered at once with the new `RPC_ERRORS.SERVER_BUSY` (`-32000`) JSON-RPC error (inside the batch reply for a batch). Notifications — `notifications/cancelled` included — are never counted nor refused.
  - **Streamable-HTTP sessions (opt-in).** `serveHttp({ sessions: true | { ttlMs, maxSessions } })`: a successful `initialize` answers with an `Mcp-Session-Id` header; later requests must carry it (400 without, 404 for an unknown/expired/foreign one) and `DELETE` ends it. All requests of a session share one cancellation scope, so a `notifications/cancelled` POSTed separately cancels the call it names — no other session can. Sessions are bound to a principal (new `principal(req)` option; default a hash of `Authorization`), expire when idle (30 min) and are capped (1000, least recently used evicted). The default stays stateless so header-less clients keep working. The session table is exported as `McpSessions` (+ `isInitializeRequest`, `MCP_SESSION_HEADER`, `DEFAULT_SESSION_TTL_MS`, `DEFAULT_MAX_SESSIONS`).
  - **Tool visibility.** `McpToolDef.visible?(ctx)` — a side-effect-free listing filter; `tools/list` omits tools it rejects (a throwing hook hides the tool). Never consulted by `tools/call`. New `CallContext.caller` carries the transport's view of the caller to it; `McpServer.listTools(ctx)` returns the filtered list (a promise). New `ToolDescriptor` type.

## 0.3.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 0.3.0

### Minor Changes

- f197518: Harden the opt-in HTTP transport (`serveHttp`) against DNS-rebinding and CSRF.
  
  Before dispatching any JSON-RPC/tool call, `serveHttp` now validates the request's `Host` and `Origin` headers, secure-by-default:
  
  - **Host (anti-DNS-rebinding):** the `Host` hostname must be a loopback name (`localhost`, `127.0.0.1`, `::1`); a foreign `Host` (e.g. `evil.com`) is rejected with `403`.
  - **Origin (anti-CSRF):** when an `Origin` header is present it must be a loopback origin; a foreign `Origin` is rejected with `403`. Requests with no `Origin` (curl, MCP-over-HTTP clients — browsers always send `Origin` on cross-site POST) are allowed.
  - The check runs before routing, so a rejected request never reaches a tool.
  
  New optional `ServeHttpOptions` (backward-compatible; default stays loopback-only): `allowedHosts?`, `allowedOrigins?`, and a full override `allowRequest?(origin, host)` — for when you deliberately bind a non-loopback `host` (e.g. `0.0.0.0` for remote/CI). These are threaded through `@basaltkit/ai-mcp`'s `createAiMcpHttpServer`. `serveHttp`'s signature is unchanged.

## 0.2.0

### Minor Changes

- 552cbe8: AI MCP bridge — M4 (prompts + polish), RFC 0001 §E. The dev-only bridge is now feature-complete per the RFC.
  
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains:
    - **Workflow prompts** (`prompts/list` + `prompts/get`): `plan-feature`, `scaffold-resource`, `harden-tenancy`, `add-rbac`. Each encodes the safe loop (analyze → plan → make **preview** → review → make apply), references the real tools/resources by name, and substitutes its arguments. The `prompts` capability is advertised.
    - **Optional HTTP transport** — an opt-in `--http[=port]` flag on the `basalt-ai-mcp` bin (and `createAiMcpHttpServer`), for remote/CI. stdio stays the default local-dev transport.
    - A **dev-only CI guard** test (RFC §D.4) asserting no workspace package lists `@basaltkit/ai` or `@basaltkit/ai-mcp` as a runtime/peer dependency.
  - **`@basaltkit/mcp-core`** adds a minimal, dependency-free **`serveHttp`** transport (pure `node:http`, no `@basaltkit/http`) — request/response JSON-RPC over `POST /mcp`. Shared by the runtime and dev servers without dragging the framework runtime into either graph.
  - **`create-basalt`** makes a `--mcp` app MCP-dev-ready: `@basaltkit/ai-mcp` is added as a **devDependency** (never a runtime dependency), a project-root `.mcp.json` registers the `basalt-ai-mcp` bridge for Claude Code/Desktop (`--cwd=.`), and the README documents the AI dev tools.
