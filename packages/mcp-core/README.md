<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/mcp-core

The **protocol substrate** for Model Context Protocol in Basalt: JSON-RPC 2.0 + MCP wire
types, a transport-neutral server over function-shaped tools/resources/prompts, and two
transports (stdio and an opt-in HTTP one). **Zero dependencies** — not even
`@basaltkit/core`.

## What this module solves

MCP is how an agent (Claude Desktop, Claude Code, an IDE, your own client) discovers and
calls tools. Two very different things in this repo need to speak it, and they must not
drag each other's dependencies along:

| Layer | Package | Tools are… | Depends on |
|---|---|---|---|
| Protocol substrate | **`@basaltkit/mcp-core`** (this one) | plain function descriptors | nothing |
| Application **runtime** surface | `@basaltkit/mcp` | opted-in `BasaltRoute`s, served from a live app | the framework runtime |
| **Dev-only** AI bridge | `@basaltkit/ai-mcp` | plain functions (`analyze`, `plan`, `make`, `review`) | `@basaltkit/ai` + this package |

Keeping the wire in one zero-dependency package is exactly what lets the dev-only bridge
reuse the same protocol implementation as the runtime server **without pulling the
framework runtime into a developer's toolchain**. If you are building an app's MCP
surface, you want `@basaltkit/mcp`, not this. You want this when you are writing a tool
server whose tools are functions, or a new transport.

There is no MCP SDK dependency: `handleMessage` implements the JSON-RPC surface directly,
so every transport shares one code path.

## Installation

```bash
pnpm add @basaltkit/mcp-core
```

Node.js, ESM. No peer dependencies.

## Get started in 5 minutes

```ts
import { McpServer, serveStdio, type McpToolDef } from '@basaltkit/mcp-core'

const echo: McpToolDef = {
  name: 'echo',
  description: 'Echo the input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async invoke(args) {
    return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
  },
}

const server = new McpServer({ tools: [echo], serverInfo: { name: 'demo', version: '1.0.0' } })
serveStdio(server) // newline-delimited JSON-RPC on stdin/stdout
```

## Usage guide

### The dispatcher — `McpServer`

`handleMessage(message, ctx?)` handles exactly one JSON-RPC message and returns the
response, or `null` for a notification (which by spec gets no reply). Implemented methods:

| Method | Always available | Notes |
|---|---|---|
| `initialize` | yes | Negotiates the protocol version and reports capabilities + `serverInfo`. |
| `ping` | yes | Replies `{}`. |
| `tools/list` · `tools/call` | yes | The core surface. `tools/list` omits tools whose optional `visible(ctx)` hook returns `false` (or throws); `tools/call` never consults it. |
| `notifications/initialized` | yes | Accepted, no reply. |
| `notifications/cancelled` | yes | Aborts the in-flight call with that `requestId` — **of the same session** only (`CallContext.session`; one per stdio stream; over HTTP the `Mcp-Session-Id` session when `serveHttp({ sessions })` is on, else one per request). |
| `resources/list` · `resources/read` | only when resources are registered | Otherwise `METHOD_NOT_FOUND`. |
| `prompts/list` · `prompts/get` | only when prompts are registered | Otherwise `METHOD_NOT_FOUND`. |

Resources and prompts are also only advertised in the `initialize` capabilities when
present, so a tools-only server is byte-for-byte a classic MCP tool server.

`callTool(name, args, ctx?)` invokes a tool directly, bypassing JSON-RPC (handy in tests);
it throws for an unknown name, where the RPC path returns `INVALID_PARAMS` instead.

### Protocol versions

`SUPPORTED_PROTOCOL_VERSIONS` is `['2025-06-18', '2025-03-26', '2024-11-05']`, newest
first; `LATEST_PROTOCOL_VERSION` is the first of those. `negotiateVersion(requested)`
honours the client's version when supported, otherwise offers the latest.

### Cancellation and progress

Every tool invocation receives a `ToolInvokeContext`:

| Field | Type | Purpose |
|---|---|---|
| `signal` | `AbortSignal` | Aborts when the client sends `notifications/cancelled` for this request id from the same session, or when the transport's own signal fires (HTTP: client disconnect). Long tools should pass it down to `fetch`/child processes. |
| `progress` | `(update: ProgressUpdate) => void` (optional) | Streams `notifications/progress` back. Present when the transport supplies a callback, or when the client sent a `_meta.progressToken` **and** the transport can `notify`. |
| `elicit` | `(prompt: string) => Promise<boolean>` (optional) | Asks the client a yes/no question via `elicitation/create`. `serveStdio` wires it when the client announced the `elicitation` capability in `initialize`; it resolves `true` only for an `accept` with `confirm: true`. Absent otherwise — a tool that needs consent must **fail closed** when it is missing. |
| `headers` | `Record<string, string \| string[] \| undefined>` (optional) | Opaque per-call transport metadata (HTTP headers; the static `headers` on stdio), forwarded verbatim. |
| `remoteAddress` | `string` (optional) | The transport peer's address (HTTP socket address). |

A request method sent as a notification (no `id`) is neither executed nor answered, and a
JSON-RPC *response* sent to the server is ignored. Batches (JSON arrays, required by
protocol revision 2025-03-26) are accepted by every bundled transport via
`dispatchPayload(server, payload, ctx)`. A second in-flight request reusing an id in the
same session is refused with `-32600`.

`ProgressUpdate` is `{ progress?, total?, message? }`.

> A tool that *fails* should return `{ content: [...], isError: true }` — the error travels
> in the result, not as a JSON-RPC protocol error. A thrown exception is caught by the
> dispatcher and mapped to `INTERNAL_ERROR` instead, which clients render less usefully.

### Transports

**stdio** (`serveStdio`) is the primary local-dev transport — newline-delimited JSON-RPC on
stdin/stdout, pure Node streams. It supplies a `notify` callback, so server→client
notifications (progress) work.

**HTTP** (`serveHttp`) is opt-in, for remote/CI: `POST` JSON-RPC to `/mcp`, one
request/response per call (the Streamable-HTTP JSON path, **no SSE**). It uses only
`node:http` — never `@basaltkit/http` — so a dev-only server keeps the framework runtime
out of its dependency graph. Server→client notifications are **not** delivered over this
transport; use stdio when you need live progress. A notification (a message with no `id`)
is answered `202` with an empty body.

The HTTP transport is secure by default because a locally-bound dev server is a real
attack surface:

- **Anti-DNS-rebinding** — the `Host` header's hostname must be a loopback name
  (`localhost`, `127.0.0.1`, `::1`) or listed in `allowedHosts`. A missing `Host` is
  rejected.
- **Anti-CSRF** — if an `Origin` header is present it must be a loopback origin or listed
  in `allowedOrigins`. Absence is allowed: a browser always sends `Origin` on a cross-site
  POST, so no `Origin` means a non-browser client (curl, an MCP HTTP client).
- Both checks run **before** routing, so a rejected request never reaches a tool.
- `allowRequest` replaces the whole guard when you need custom logic.
- **The guard is not authentication.** `Host` is whatever the client sends — any
  non-browser client can send `Host: 127.0.0.1`. Binding a non-loopback `host` is therefore
  **refused** unless `authorize` (e.g. a bearer-token check → `401`) or `allowRequest` is set.
- **Body cap** — bodies over `maxBodyBytes` (default 1 MiB) are answered `413` without
  being buffered.
- **Sessions (opt-in)** — `sessions: true` (or `{ ttlMs, maxSessions }`) issues an
  `Mcp-Session-Id` on a successful `initialize` and requires it afterwards (`400`
  without, `404` for an unknown, expired or foreign one; `DELETE` ends it). All requests
  of a session share one cancellation scope, so a `notifications/cancelled` POSTed
  separately cancels the call — no other session can. A session is bound to
  `principal(req)` (default: a hash of `Authorization`), expires after 30 min idle and at
  most 1000 live (LRU eviction). Stateless by default, so header-less clients keep
  working; the table is exported as `McpSessions`.

stdio caps concurrency too: at most `maxConcurrentRequests` (default 16) requests run at
once per connection; one more is answered at once with `-32000`
(`RPC_ERRORS.SERVER_BUSY`). Notifications are never counted nor refused, so a cancel
always gets through.

## API reference

### `new McpServer(options?)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `tools` | `McpToolDef[]` | `[]` | The callable tools, keyed by `name` (a duplicate name wins last). |
| `resources` | `McpResourceDef[]` | `[]` | Read-only context the agent can pull, keyed by `uri`. Registering any enables `resources/*`. |
| `prompts` | `McpPromptDef[]` | `[]` | Reusable prompt templates, keyed by `name`. Registering any enables `prompts/*`. |
| `serverInfo` | `McpServerInfo` (`{ name, version }`) | `{ name: 'basalt-mcp-core', version: '0.1.0' }` | Identity reported in `initialize`. Set it — clients show it to the user. |

Definition shapes:

- `McpToolDef` — `{ name, description, inputSchema, outputSchema?, invoke(args, ctx), visible?(ctx) }`.
  `visible` is a side-effect-free listing filter (it receives the `CallContext`,
  including the opaque `caller` a transport supplies) — never authorization.
  Schemas are plain JSON Schema objects; `invoke` returns an `McpToolResult`
  (`{ content, structuredContent?, isError? }`) where `content` is `{ type: 'text', text }[]`.
- `McpResourceDef` — `{ uri, name, description?, mimeType?, read(ctx) }`; `read` returns
  `{ text, uri?, mimeType? }` (`uri` defaults to the resource's own).
- `McpPromptDef` — `{ name, description?, arguments?, get(args) }`; `arguments` are
  `{ name, description?, required? }`, and `get` returns `{ description?, messages }`.

### `serveStdio(server, options?)` → `StdioHandle`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `headers` | `Record<string, string>` | `{}` | Static per-call metadata handed to every tool as `ctx.headers` — stdio has no per-request headers. |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Injectable for tests. |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Injectable for tests. |
| `maxLineLength` | `number` | `4194304` (4 MiB) | Longest accepted line, in characters. A longer one is dropped without buffering and answered `-32600`. |
| `maxConcurrentRequests` | `number` | `16` (`DEFAULT_MAX_CONCURRENT_REQUESTS`) | Requests in flight at once on the connection; one more gets `-32000` (`SERVER_BUSY`). Notifications are never refused. |

Input is decoded with a `StringDecoder`, so a multibyte character split across chunks is
reassembled. `StdioHandle.close()` detaches the stdin listener (it does not end the process)
and resolves any pending elicitation as declined.

### `serveHttp(server, options?)` → `Promise<HttpHandle>`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `port` | `number` | `0` | `0` picks an ephemeral port — read the real one from the handle. |
| `host` | `string` | `'127.0.0.1'` | Loopback, because this is a dev-only surface. Change it only deliberately. An IPv6 address works bare or bracketed (`'::1'` / `'[::1]'`); `handle.url` brackets it (`http://[::1]:8848/mcp`). |
| `path` | `string` | `'/mcp'` | The JSON-RPC endpoint. Anything else answers `404`. |
| `allowedHosts` | `string[]` | `[]` | Extra hostnames accepted in `Host`, beyond loopback. Needed when you bind a non-loopback `host` (e.g. `0.0.0.0` in CI). Compared case-insensitively, port ignored. |
| `allowedOrigins` | `string[]` | `[]` | Extra origins accepted in `Origin`, beyond loopback. Compared case-insensitively against the full origin. |
| `allowRequest` | `(origin, host, req) => boolean` | — | Full override of the guard. When set it **replaces** the loopback + `allowedHosts`/`allowedOrigins` checks — you own the security decision. |
| `authorize` | `(req) => boolean \| Promise<boolean>` | — | Authenticates a request that passed the guard; `false` answers `401`. Required (or `allowRequest`) for a non-loopback `host`. |
| `maxBodyBytes` | `number` | `1048576` (1 MiB) | Larger bodies get `413` and are not buffered. |
| `sessions` | `boolean \| { ttlMs?, maxSessions? }` | `false` | `Mcp-Session-Id` sessions (30 min idle, 1000 live by default) — cross-request cancellation, bound to the principal. |
| `principal` | `(req) => string \| undefined \| Promise<…>` | hash of `Authorization` | Who a session is bound to; another principal presenting the id gets `404`. |

`HttpHandle` is `{ port, url, close(): Promise<void> }`. The promise rejects with the
`listen()` error (`EADDRINUSE`, `EADDRNOTAVAIL`, …) when the address cannot be bound.

Over HTTP, `ctx.headers` holds the request headers with their multiplicity kept: a header
sent once is a string, a header sent more than once is a `string[]` of every value, in
order. Node's own `req.headers` would join most repeats with `, ` and keep only the first
`authorization`/`host`/`content-type` — a tool that treats a duplicated header as ambiguous
(and refuses) should check `Array.isArray(ctx.headers[name])`.

### Protocol helpers

`ok(id, result)` · `fail(id, code, message, data?)` · `isNotification(message)` ·
`negotiateVersion(requested)` · `SUPPORTED_PROTOCOL_VERSIONS` · `LATEST_PROTOCOL_VERSION` ·
`RPC_ERRORS`. Types: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`, `JsonRpcId`,
`McpContent`, `McpToolResult`.

## Failure modes

This package throws no error classes of its own. Failures travel as JSON-RPC error codes
(`RPC_ERRORS`):

| Error | Code | HTTP | When |
|---|---|---|---|
| Parse error | `PARSE_ERROR` (`-32700`) | 400 (HTTP transport) | The body/line wasn't valid JSON. |
| Invalid request | `INVALID_REQUEST` (`-32600`) | 200 / 401 / 403 / 413 | `jsonrpc !== '2.0'` or a non-string `method`, an empty batch, a batched `initialize`, a reused in-flight id, an over-long stdio line. Also the code used for the HTTP transport's `401` (authorize), `403` (host/origin) and `413` (body cap). |
| Method not found | `METHOD_NOT_FOUND` (`-32601`) | 200 / 404 | Unknown method — including `resources/*` or `prompts/*` when none are registered. Also the HTTP transport's `404` for a wrong path or non-`POST`. |
| Invalid params | `INVALID_PARAMS` (`-32602`) | 200 | `tools/call` without a string `name`, an unknown tool/resource/prompt, or `resources/read`/`prompts/get` without a string `uri`/`name`. |
| Internal error | `INTERNAL_ERROR` (`-32603`) | 200 | A handler threw. The thrown `Error.message` is passed through — do not put secrets in it. |

Notifications never produce an error response: a failure while handling one returns `null`.

Symptoms:

- **The client shows no tools** — `initialize` succeeded but `tools/list` is empty; check
  you passed `tools` to the constructor.
- **`resources/list` returns `METHOD_NOT_FOUND`** — no resources are registered; the method
  is only wired up when at least one exists.
- **The HTTP transport answers `403` to everything** — a non-loopback `Host` (you bound
  `0.0.0.0`, or a proxy rewrites `Host`). Add it to `allowedHosts`.
- **`serveHttp` rejects with "refusing to bind non-loopback host"** — give it `authorize`
  (or `allowRequest`); the Host guard alone does not protect a network-reachable server.
- **`serveHttp` rejects with `EADDRINUSE`** — the port is taken (another server, or a
  previous run still alive). Pick another `port`, or `0` for an ephemeral one. Releases
  before 0.4.0 never settled in this case.
- **Progress updates never arrive over HTTP** — expected: that transport has no
  server→client channel. Use stdio.
- **A cancelled call keeps running** — the tool ignored `ctx.signal`; the abort is
  delivered, but only cooperative code stops. Or the cancel came from another session
  (over HTTP, turn on `serveHttp({ sessions: true })` and send the cancel with the same
  `Mcp-Session-Id`; stateless, every request is its own session — disconnect instead).
- **`400 Mcp-Session-Id header required` / `404 Session not found`** — with sessions on,
  send `initialize` first and echo its header; a 404 means the session expired, was
  evicted or ended, or another principal presented it — re-initialize.
- **stdio answers `-32000 Too many requests in flight`** — more than
  `maxConcurrentRequests` calls running on the connection; wait, or raise the cap.

## How it connects to other modules

- **`@basaltkit/mcp`** — the application's *runtime* MCP surface: it turns opted-in
  `BasaltRoute`s into tools and serves them over HTTP or stdio, on top of this package.
  That is the one you register in a Basalt app.
- **`@basaltkit/ai-mcp`** — the **dev-only** AI bridge, built on this package plus
  `@basaltkit/ai`. It must never become a runtime dependency of an application.
- Nothing here imports `@basaltkit/core` or `@basaltkit/http`, and it must stay that way —
  that constraint is the whole reason this package exists.

Guides: [MCP](/guide/mcp) · [MCP core](/guide/mcp-core) · [AI MCP bridge](/guide/ai-mcp) · [AI](/guide/ai)
