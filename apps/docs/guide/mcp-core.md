# Building an MCP server (`@basaltkit/mcp-core`)

`@basaltkit/mcp-core` is the **zero-dependency** wire underneath Basalt's MCP
story: the JSON-RPC 2.0 + [Model Context Protocol](https://modelcontextprotocol.io)
types, a transport-neutral server that dispatches over **function-shaped**
tools / resources / prompts (with progress + cancellation), and **stdio** and
**HTTP** transports. It has no runtime dependencies — no `@basaltkit/core`, no
`@basaltkit/http`, no external SDK. Reach for it when you want an MCP server whose
tools are plain functions, with nothing else in the dependency graph.

::: tip Which MCP package do I want?
- Exposing **your app's routes** to agents in production → [`@basaltkit/mcp`](/guide/mcp)
  (routes become tools through the neutral pipeline; tenancy/auth apply).
- Exposing **Basalt dev workflows** to your editor → [`@basaltkit/ai-mcp`](/guide/ai-mcp).
- Building **your own** MCP server from arbitrary functions, with no framework
  runtime in the graph → **this package.**

`@basaltkit/mcp` and `@basaltkit/ai-mcp` are both built on `mcp-core`.
:::

[[toc]]

## Where `mcp-core` fits

| Layer | Package | Role | Runtime? |
| --- | --- | --- | --- |
| Intelligence | [`@basaltkit/ai`](/guide/ai) | The `basalt ai` CLI: analyze, doctor, plan, make, review | dev-only |
| Dev bridge | [`@basaltkit/ai-mcp`](/guide/ai-mcp) | Exposes those dev workflows to your editor over MCP | dev-only |
| Wire | **`@basaltkit/mcp-core`** | **This page** — protocol + generic server + transports | shared |
| Runtime surface | [`@basaltkit/mcp`](/guide/mcp) | Your app's opt-in routes become tools for agents | runtime |

The mental model is one dispatcher and two transports. `McpServer.handleMessage()`
turns a JSON-RPC message into a result *without knowing how it arrived*; `serveStdio`
and `serveHttp` are thin loops that read a message, call `handleMessage`, and write
the response back. Everything else — your tools, resources and prompts — is a plain
object with a function on it.

## Install

```bash
pnpm add @basaltkit/mcp-core
```

## Hello, tool (stdio)

A tool is a plain descriptor with an `invoke` function — no routes, no DI
container:

```ts
import { McpServer, serveStdio, type McpToolDef } from '@basaltkit/mcp-core'

const echo: McpToolDef = {
  name: 'echo',
  description: 'Echo the input back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async invoke(args) {
    return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
  },
}

const server = new McpServer({
  tools: [echo],
  serverInfo: { name: 'demo', version: '1.0.0' },
})

// Serve newline-delimited JSON-RPC on stdin/stdout (what local agents speak).
serveStdio(server)
```

Point any stdio MCP client at the process and you'll see `echo` in `tools/list`.

## The server

`new McpServer({ tools?, resources?, prompts?, serverInfo? })` builds a
transport-neutral server. Its `handleMessage(message, ctx?)` implements the MCP
JSON-RPC surface:

| Method | Behaviour |
| --- | --- |
| `initialize` | Negotiates the protocol version, returns `{ protocolVersion, capabilities, serverInfo }` |
| `ping` | Returns `{}` |
| `tools/list` · `tools/call` | Always available |
| `resources/list` · `resources/read` | Only when resources are registered — otherwise `METHOD_NOT_FOUND` |
| `prompts/list` · `prompts/get` | Only when prompts are registered — otherwise `METHOD_NOT_FOUND` |
| `notifications/initialized` | Accepted, no reply |
| `notifications/cancelled` | Aborts the in-flight call **of the same session** whose `params.requestId` matches; no reply |

A request method sent as a notification (no `id`, e.g. a `tools/call` without
one) is **neither executed nor answered** — JSON-RPC never answers a
notification. A JSON-RPC *response* sent to the server is ignored. Batches
(arrays) are dispatched by `dispatchPayload(server, payload, ctx)`, which every
bundled transport uses: one response per request, `null` for an all-notification
batch, `-32600` for an empty batch or a batched `initialize`.

Capabilities are advertised **only when present**: a tools-only server reports
`{ tools: { listChanged: false } }`; register resources or prompts and the
matching capability appears. `serverInfo` defaults to
`{ name: 'basalt-mcp-core', version: '0.1.0' }` — set your own.

Two methods let you drive the server without the JSON-RPC layer, which is what
tests and embedders usually want:

```ts
server.listTools()                         // the tool descriptors tools/list returns
await server.callTool('echo', { text: 'hi' })  // throws `Unknown tool: …` for a bad name
```

::: warning Names and URIs are keys, and last one wins
Tools and prompts are stored in a `Map` keyed by `name`, resources by `uri`. Two
descriptors with the same key means the later one **silently replaces** the
earlier — there is no duplicate check. Generate names deterministically, or assert
`server.listTools().length` in a test.
:::

## Tools

```ts
interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema
  outputSchema?: Record<string, unknown> // optional; advertised on tools/list
  invoke(args: Record<string, unknown>, ctx: ToolInvokeContext): Promise<McpToolResult>
  visible?(ctx: CallContext): boolean | Promise<boolean> // optional listing filter
}
```

`visible` lets a tool leave itself out of a caller's `tools/list` (it receives
the transport's `CallContext`, including the opaque `caller`). It must be free of
side effects — it runs on every listing — and it is **not** authorization:
`tools/call` never consults it, so `invoke` still enforces access. A hook that
throws hides the tool.

Return an `McpToolResult`: `{ content: [{ type: 'text', text }], structuredContent?, isError? }`.
Per the spec, `structuredContent` must be a JSON object (a record) — arrays and
primitives ride in `content` text only.

There are **two** ways for a tool to fail, and the difference matters:

- **A tool-level failure** — return `{ content: [...], isError: true }`. The call
  succeeds at the protocol level and the agent reads your message. This is what you
  want for bad arguments, a refused operation, a missing credential: the model can
  see the reason and try something else.
- **A thrown error** — becomes a JSON-RPC `INTERNAL_ERROR` (`-32603`) carrying the
  error's `message`. Reserve it for genuine bugs.

### The invoke context — signal, progress, elicit

Every call receives a `ToolInvokeContext`:

```ts
interface ToolInvokeContext {
  signal: AbortSignal                              // client cancellation
  progress?: (u: { progress?: number; total?: number; message?: string }) => void
  elicit?: (prompt: string) => Promise<boolean>    // ask the client to confirm
  headers?: Record<string, string | string[] | undefined>  // per-call transport metadata
  remoteAddress?: string                           // the transport peer, when known
}
```

`signal` is always present. `progress`, `elicit`, `headers` and `remoteAddress` are present only
when the transport or the client supplied them — always call them optionally
(`ctx.progress?.(…)`), never assume.

```ts
const build: McpToolDef = {
  name: 'build',
  description: 'A long job that reports progress and honours cancellation',
  inputSchema: { type: 'object' },
  async invoke(_args, ctx) {
    for (let i = 0; i < 3; i++) {
      if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      ctx.progress?.({ progress: i + 1, total: 3, message: `step ${i + 1}` })
      await step(i)
    }
    // Confirmation: when the client cannot be asked, FAIL CLOSED — never
    // treat a missing `elicit` as consent.
    if (!ctx.elicit || !(await ctx.elicit('Write the output?'))) {
      return { content: [{ type: 'text', text: 'not confirmed' }], isError: true }
    }
    return { content: [{ type: 'text', text: 'done' }] }
  },
}
```

## Progress & cancellation

The plumbing is wired into the dispatcher, so you don't touch the wire:

- **Progress** — when a `tools/call` carries `params._meta.progressToken` **and**
  the transport supplied a `notify` callback, `ctx.progress(...)` emits
  `notifications/progress` with that token. Miss either half and `ctx.progress` is
  simply `undefined` — hence the optional call.
- **Cancellation** — each in-flight `tools/call` with a non-null id gets a
  per-request `AbortController`, registered under `(session, id)`. A
  `notifications/cancelled` with the matching `requestId` **from the same
  session** aborts `ctx.signal` — one client can never cancel another's call.
  The session is `CallContext.session`: each stdio stream is its own; over HTTP
  it is the `Mcp-Session-Id` session when `serveHttp({ sessions })` is on (so a
  cancel `POST`ed separately reaches the call), else each request; a
  session-less embedding shares one scope. A second in-flight
  request reusing an id in the same session is refused (`-32600`). An external
  `ctx.signal` passed by the transport is linked into the same controller, so an
  already-aborted signal aborts the call immediately (`serveHttp` aborts when the
  client disconnects).
- **Elicitation** — over stdio, when the client's `initialize` announced the
  `elicitation` capability, `ctx.elicit(prompt)` sends an `elicitation/create`
  request (a single required `confirm` boolean) and resolves `true` only when the
  user accepted with `confirm: true`. Without the capability `ctx.elicit` is
  absent.

Live server→client notifications (progress) require a duplex transport — **stdio**
delivers them; the minimal HTTP transport is request/response only.

## Resources

Read-only context an agent can pull, addressed by URI:

```ts
import type { McpResourceDef } from '@basaltkit/mcp-core'

const context: McpResourceDef = {
  uri: 'demo://project/context',
  name: 'Project context',
  description: 'The current project state',
  mimeType: 'application/json',
  read() {
    return { text: JSON.stringify({ ok: true }) } // { uri?, mimeType?, text }
  },
}

new McpServer({ resources: [context] })
```

`read(ctx)` receives a `ResourceReadContext` (`{ signal }`) and may be sync or
async. `resources/read` returns `{ contents: [{ uri, mimeType?, text }] }`,
defaulting `uri`/`mimeType` from the descriptor. Resources take **no arguments** —
if a client needs to parameterise a read, that's a tool, not a resource. An unknown
URI fails `INVALID_PARAMS`.

## Prompts

Parameterised message templates (they surface as slash commands in some clients):

```ts
import type { McpPromptDef } from '@basaltkit/mcp-core'

const greet: McpPromptDef = {
  name: 'greet',
  description: 'A greeting template',
  arguments: [{ name: 'who', description: 'Name to greet', required: true }],
  get(args) {
    return {
      description: `Greet ${args['who']}`,
      messages: [{ role: 'user', content: { type: 'text', text: `Hi ${args['who']}` } }],
    }
  },
}

new McpServer({ prompts: [greet] })
```

`arguments` is advertising only — the dispatcher passes
`params.arguments` through as a `Record<string, string>` without validating
`required`. Default missing values in `get()` yourself.

## Transports

### stdio

```ts
import { serveStdio } from '@basaltkit/mcp-core'

const handle = serveStdio(server, {
  // headers?: applied to every call (stdio has no per-request headers)
  // input?: NodeJS.ReadableStream (default process.stdin)
  // output?: { write(chunk: string): unknown } (default process.stdout)
  // maxLineLength?: number (default 4 MiB of characters)
  // maxConcurrentRequests?: number (default 16)
})
handle.close() // detach the stdin listener
```

Newline-delimited JSON-RPC: one message per line, one response per line (an
array for a batch). Blank lines are skipped, notifications get no reply, and an
unparseable line answers with a JSON-RPC parse error (`-32700`, id `null`). The
byte stream is decoded with a `StringDecoder`, so a multibyte character split
across chunks survives; a line longer than `maxLineLength` is dropped without
being buffered and answered with `-32600`. At most `maxConcurrentRequests`
requests (messages with an `id`) run at once per connection; one more is
answered immediately with `-32000` (`RPC_ERRORS.SERVER_BUSY`) — inside the batch
reply for a batch — while notifications (a `notifications/cancelled` included)
are never counted nor refused. The transport also supplies `notify`,
so server→client notifications (progress) and requests (`elicitation/create`) go
out on the same stream, and the client's responses are routed back.

::: danger stdout is the protocol
On stdio, anything your process prints to stdout is interpreted as JSON-RPC. One
stray `console.log` corrupts the stream and the client sees a dead server. Log to
stderr, or silence logging entirely in a stdio entry point.
:::

### HTTP (opt-in)

```ts
import { serveHttp } from '@basaltkit/mcp-core'

const http = await serveHttp(server, { port: 0, host: '127.0.0.1', path: '/mcp' })
console.log(http.url)   // http://127.0.0.1:<port>/mcp
await http.close()
```

A minimal `node:http` server — `POST` JSON-RPC to `path`, one request/response per
call (no SSE). It uses only `node:http`, so a dev-only server keeps the framework
runtime out of its graph. Responses:

| Status | When |
| --- | --- |
| `200` | A normal JSON-RPC response |
| `202` (empty body) | The message was a notification — by spec it gets no reply |
| `400` | The body wasn't valid JSON (`-32700 Parse error`) — or, with `sessions` on, a non-`initialize` request without `Mcp-Session-Id` |
| `401` | `authorize` returned `false` |
| `403` | The request guard rejected the `Host`/`Origin` — checked **before** routing |
| `404` | Wrong method or off-path (`-32601 Not found: <method> <url>`) — or, with `sessions` on, an unknown, expired or foreign session |
| `204` | `DELETE` with a live `Mcp-Session-Id` (sessions on) ended the session |
| `413` | The body exceeds `maxBodyBytes` (default 1 MiB) — it is never buffered |

Incoming HTTP headers are forwarded to tools as `ctx.headers` (and the peer
address as `ctx.remoteAddress`), so a tool can read per-call metadata (a tenant
id, a bearer token) the same way it would over stdio's static `headers`. A header
sent once is a string; a header sent more than once is a `string[]` of every value
(Node's `req.headers` would join them with `, `, or keep only the first
`authorization`) — so a tool can refuse an ambiguous duplicate with
`Array.isArray(ctx.headers[name])`. An IPv6 `host` works bare or bracketed
(`'::1'`, `handle.url` → `http://[::1]:port/mcp`), and `serveHttp` rejects with the
`listen()` error (`EADDRINUSE`) when the address cannot be bound.

#### Sessions (opt-in) {#http-sessions}

`serveHttp(server, { sessions: true })` (or `{ ttlMs, maxSessions }`) turns on
Streamable-HTTP sessions: a successful `initialize` answers with an
`Mcp-Session-Id` header, every later request must carry it, and `DELETE` with
it ends the session. All requests of a session share one cancellation scope, so
a `notifications/cancelled` `POST`ed while a call runs cancels it — a different
session, even one guessing the request id, never can. Each session is bound to
a principal — `principal(req)` if you pass one, else a hash of the
`Authorization` header — and a request presenting another principal is treated
like an unknown session (404). Sessions expire after `ttlMs` idle (default 30
min) and at most `maxSessions` live (default 1000; the least recently used is
evicted). The table is exported as `McpSessions` for other transports (the
runtime `/mcp` route of `@basaltkit/mcp` uses it). The default stays stateless
(each request its own session) so header-less clients of an existing dev bridge
keep working.

::: warning The HTTP transport is loopback-guarded by default
It binds `127.0.0.1`, and before any dispatch it requires the `Host` hostname to be
a loopback name (anti-DNS-rebinding) and — *when an `Origin` header is present* —
that origin to be a loopback origin (anti-CSRF; browsers always send `Origin` on a
cross-site POST, so its absence means a non-browser client and is allowed). Widen
it deliberately with `allowedHosts` / `allowedOrigins`, or replace the whole check
with `allowRequest`.

That guard stops **browsers**; it is **not authentication** — the `Host` header
is whatever the client sends, and any non-browser client can send
`Host: 127.0.0.1`. So binding a non-loopback `host` (e.g. `0.0.0.0`) is
**refused** unless you also pass `authorize` (e.g. a bearer-token check) or
`allowRequest`. This transport is a dev/CI surface, not a public endpoint.
:::

## Protocol details

```ts
import {
  SUPPORTED_PROTOCOL_VERSIONS, // ['2025-06-18', '2025-03-26', '2024-11-05']
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,                  // PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, …
  negotiateVersion,            // honour the client's version if supported, else latest
  ok, fail, isNotification,    // response builders + the "no id ⇒ no reply" rule
} from '@basaltkit/mcp-core'
```

`initialize` negotiates the protocol version (`negotiateVersion`) and returns the
server's capabilities + `serverInfo`. Basalt speaks MCP directly — there is no SDK
dependency, and the same `handleMessage` drives every transport.

| Constant | Value |
| --- | --- |
| `RPC_ERRORS.PARSE_ERROR` | `-32700` |
| `RPC_ERRORS.INVALID_REQUEST` | `-32600` |
| `RPC_ERRORS.METHOD_NOT_FOUND` | `-32601` |
| `RPC_ERRORS.INVALID_PARAMS` | `-32602` |
| `RPC_ERRORS.INTERNAL_ERROR` | `-32603` |

## Contrast: `mcp-core` vs runtime `@basaltkit/mcp`

| | `@basaltkit/mcp-core` | [`@basaltkit/mcp`](/guide/mcp) |
| --- | --- | --- |
| Tools are… | arbitrary **functions** (`McpToolDef`) | opt-in **routes** (`meta.mcp`) |
| Dependencies | **zero** | `@basaltkit/core` + `@basaltkit/http` |
| Runs through | your `invoke` | the neutral request pipeline (tenancy/auth) |
| Use when | building a standalone/dev MCP server | exposing an app's API to agents |

Reach for `mcp-core` when you want a small, framework-free MCP server (a dev tool,
a CLI companion, a bespoke agent surface). Reach for `@basaltkit/mcp` when the
tools *are* your app's endpoints and should honour the same validation, tenancy
and auth as HTTP.

## Options reference

### `new McpServer(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `tools` | `McpToolDef[]` | `[]` | The callable surface. An empty list still advertises the `tools` capability |
| `resources` | `McpResourceDef[]` | `[]` | Read-only context. Registering any enables `resources/list` + `resources/read` |
| `prompts` | `McpPromptDef[]` | `[]` | Message templates. Registering any enables `prompts/list` + `prompts/get` |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt-mcp-core', version: '0.1.0' }` | What `initialize` reports — clients show this, so set it |

### `McpToolDef`

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `name` | `string` | yes | The `tools/call` key. Duplicates silently overwrite |
| `description` | `string` | yes | How the model decides to call it — the highest-leverage string in the file |
| `inputSchema` | `Record<string, unknown>` | yes | JSON Schema for the arguments; not enforced by the dispatcher, validate inside `invoke` |
| `outputSchema` | `Record<string, unknown>` | no | Advertised on `tools/list` so a client can type the result |
| `visible` | `(ctx: CallContext) => boolean \| Promise<boolean>` | no | Side-effect-free listing filter: `false` leaves the tool out of this caller's `tools/list`. Never consulted by `tools/call` |
| `invoke` | `(args, ctx) => Promise<McpToolResult>` | yes | The work. Return `isError: true` for expected failures; throw only for bugs |

### `McpResourceDef` / `McpPromptDef`

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `McpResourceDef.uri` | `string` | yes | The `resources/read` key and the default `contents[0].uri` |
| `McpResourceDef.name` · `description` | `string` | name only | Listing metadata |
| `McpResourceDef.mimeType` | `string` | no | Default MIME for reads that don't set their own |
| `McpResourceDef.read` | `(ctx: { signal }) => McpResourceContents \| Promise<…>` | yes | Returns `{ uri?, mimeType?, text }`; sync or async |
| `McpPromptDef.name` · `description` | `string` | name only | The `prompts/get` key and listing metadata |
| `McpPromptDef.arguments` | `McpPromptArgument[]` | no | Advertising only — `required` is **not** enforced |
| `McpPromptDef.get` | `(args: Record<string, string>) => McpPromptResult \| Promise<…>` | yes | Returns `{ description?, messages }` |

### `serveStdio(server, options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Static per-call metadata — stdio has no per-request headers, so this is how a local client carries a token or tenant |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Inject a stream in tests |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Inject a sink in tests |
| `maxLineLength` | `number` | `4194304` (4 MiB of characters) | A longer line is dropped (answered `-32600`) instead of growing the buffer |
| `maxConcurrentRequests` | `number` | `16` (`DEFAULT_MAX_CONCURRENT_REQUESTS`) | Requests in flight at once per connection; one more gets `-32000` (`SERVER_BUSY`). Notifications are never refused |

Returns a `StdioHandle`; `close()` detaches the `data` listener (it does not end
the stream).

### `serveHttp(server, options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `port` | `number` | `0` | `0` picks an ephemeral port — read it back from the handle |
| `host` | `string` | `'127.0.0.1'` | Bind address. Loopback by default because this is a dev surface |
| `path` | `string` | `'/mcp'` | The JSON-RPC endpoint. Anything else answers `404` |
| `allowedHosts` | `string[]` | loopback names only | Extra `Host` hostnames to accept when you deliberately bind off loopback. Case-insensitive, port ignored |
| `allowedOrigins` | `string[]` | loopback origins only | Extra `Origin` values (full scheme + host + port) |
| `allowRequest` | `(origin: string \| undefined, host: string \| undefined, req: IncomingMessage) => boolean` | — | Full override — **replaces** the loopback/`allowedHosts`/`allowedOrigins` checks. Returning `true` unconditionally disables the guard |
| `authorize` | `(req: IncomingMessage) => boolean \| Promise<boolean>` | — | Authenticates a request that passed the guard; `false` answers `401`. Required (or `allowRequest`) to bind a non-loopback `host` |
| `maxBodyBytes` | `number` | `1048576` (1 MiB) | Larger bodies get `413` and are not buffered |
| `sessions` | `boolean \| { ttlMs?: number; maxSessions?: number }` | `false` (stateless) | `Mcp-Session-Id` sessions — see [Sessions](#http-sessions) |
| `principal` | `(req: IncomingMessage) => string \| undefined \| Promise<…>` | hash of `Authorization` | Who a session is bound to |

Returns `Promise<HttpHandle>` — `{ port, url, close() }`.

### `CallContext` — what a transport supplies

You only build this yourself when embedding `handleMessage` in your own transport.

| Field | Type | Supplied by | Purpose |
| --- | --- | --- | --- |
| `headers` | `Record<string, string \| string[] \| undefined>` | stdio (`options.headers`), HTTP (request headers) | Forwarded verbatim to `ctx.headers` in tools |
| `progress` | `(u: ProgressUpdate) => void` | you | An explicit progress sink; takes precedence over the `progressToken` + `notify` pairing |
| `elicit` | `(prompt: string) => Promise<boolean>` | stdio (when the client announced `elicitation`), or you | Ask the client to confirm; surfaces as `ctx.elicit` |
| `notify` | `(message: JsonRpcRequest) => void` | stdio | Push server→client notifications. Without it, `progressToken` progress is dropped |
| `signal` | `AbortSignal` | HTTP (client disconnect), or you | An external abort linked into the per-request controller |
| `session` | `unknown` (compared by identity) | stdio (one per stream), HTTP (the `Mcp-Session-Id` session, or one per request when stateless) | Scopes in-flight ids: `notifications/cancelled` only reaches calls of the same session. Omitted ⇒ one shared scope |
| `caller` | `unknown` | you / the runtime `/mcp` route (the request context) | Handed to tools' `visible` hooks; the core never reads it |
| `remoteAddress` | `string` | HTTP (socket address) | Forwarded to `ctx.remoteAddress` |

## Failure modes & troubleshooting

| Message | Code | Where | When |
| --- | --- | --- | --- |
| `Parse error` | `-32700` | stdio line, HTTP body | The message wasn't valid JSON. HTTP answers `400`; stdio replies with id `null` |
| `Invalid JSON-RPC request` | `-32600` | `handleMessage` | `jsonrpc !== '2.0'` or `method` isn't a string |
| `Forbidden: host/origin not allowed` | `-32600` (HTTP `403`) | `serveHttp` guard | Foreign `Host` or `Origin`; rejected before any dispatch |
| `Unauthorized` | `-32600` (HTTP `401`) | `serveHttp` `authorize` | `authorize` returned `false` (or threw) |
| `Request body exceeds <n> bytes` | `-32600` (HTTP `413`) | `serveHttp` | Body over `maxBodyBytes` |
| `Message exceeds the maximum line length (<n>)` | `-32600` | stdio | Line over `maxLineLength`; the line is dropped |
| `Request id <id> is already in flight` | `-32600` | `dispatchToolCall` | The same session reused an id still running |
| `Too many requests in flight (max <n>); retry later` | `-32000` | stdio | Over `maxConcurrentRequests` requests running on the connection |
| `Bad Request: Mcp-Session-Id header required …` | `-32600` (HTTP `400`) | `serveHttp` (sessions on) | A request other than `initialize` without the header |
| `Session not found …` | `-32600` (HTTP `404`) | `serveHttp` (sessions on) | Unknown, expired, evicted or foreign session — re-initialize |
| `serveHttp: refusing to bind non-loopback host …` | (rejected promise) | `serveHttp` | Non-loopback `host` without `authorize`/`allowRequest` |
| `Method not found: <method>` | `-32601` | `handleMessage` | An unknown method — **or** `resources/*` / `prompts/*` on a server that registered none |
| `Not found: <method> <url>` | `-32601` (HTTP `404`) | `serveHttp` | Non-`POST`, or a path other than `options.path` |
| ``tools/call requires a string `name` `` | `-32602` | `dispatchToolCall` | `params.name` missing or not a string |
| `Unknown tool: <name>` | `-32602` (or a thrown `Error` from `callTool`) | dispatcher / `callTool` | No tool registered under that name |
| ``resources/read requires a string `uri` `` · `Unknown resource: <uri>` | `-32602` | `dispatchResourceRead` | Missing/unknown resource URI |
| ``prompts/get requires a string `name` `` · `Unknown prompt: <name>` | `-32602` | `dispatchPromptGet` | Missing/unknown prompt name |
| *(the thrown error's message)* | `-32603` | `handleMessage` catch | A tool, resource or prompt **threw**. Prefer `isError: true` for expected failures |

- **The client shows the server as dead, immediately** — on stdio, something wrote
  to stdout that wasn't JSON-RPC. Route all logging to stderr.
- **`ctx.progress` is undefined in my tool** — progress needs *both* a client
  `_meta.progressToken` *and* a transport `notify`. Over HTTP there is no `notify`,
  so progress is never delivered; use stdio, or pass an explicit `progress` in a
  `CallContext` when embedding.
- **Cancellation does nothing** — `notifications/cancelled` only aborts calls
  registered under a non-null request id **in the same session** (over HTTP,
  turn on `serveHttp({ sessions: true })` and send the cancel with the same
  `Mcp-Session-Id`; stateless, each request is its own session — disconnect
  instead), and your `invoke` must
  actually observe `ctx.signal`. A tight synchronous loop will never notice it.
- **My `tools/call` without an `id` never runs** — by design: a request method
  sent as a notification is not executed (its result could never be delivered).
- **`resources/list` returns `-32601` even though I registered a resource** — the
  method is enabled by the resources passed to the **constructor**; there is no
  post-construction `register()`. Build the server with the full list.
- **`structuredContent` is ignored by my client** — MCP requires it to be a JSON
  object. Arrays and primitives must ride in `content` as text.
- **Two tools, one shows up** — duplicate `name`s overwrite in the `Map`.

## See also

- [`@basaltkit/ai-mcp`](/guide/ai-mcp) — the dev bridge built on this package.
- [MCP (runtime)](/guide/mcp) — routes as tools, in production.
- [AI-assisted development](/guide/ai) — the workflows the dev bridge exposes.
- Source: `packages/mcp-core/src/**` (`protocol.ts`, `server.ts`, `stdio.ts`, `http.ts`).
