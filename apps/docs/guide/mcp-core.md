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
| `notifications/cancelled` | Aborts the in-flight call whose `params.requestId` matches; no reply |

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
}
```

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
}
```

`signal` is always present. `progress`, `elicit` and `headers` are present only
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
    // Optional interactive confirmation, when the client supports elicitation:
    if (ctx.elicit && !(await ctx.elicit('Write the output?'))) {
      return { content: [{ type: 'text', text: 'skipped' }], isError: true }
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
  per-request `AbortController`, registered under that id. A
  `notifications/cancelled` with the matching `requestId` aborts `ctx.signal`. An
  external `ctx.signal` passed by the transport is linked into the same controller,
  so an already-aborted signal aborts the call immediately.

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
})
handle.close() // detach the stdin listener
```

Newline-delimited JSON-RPC: one message per line, one response per line. Blank
lines are skipped, notifications get no reply, and an unparseable line answers with
a JSON-RPC parse error (`-32700`, id `null`). The transport also supplies `notify`,
so server→client notifications (progress) go out on the same stream.

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
| `400` | The body wasn't valid JSON (`-32700 Parse error`) |
| `403` | The request guard rejected the `Host`/`Origin` — checked **before** routing |
| `404` | Wrong method or off-path (`-32601 Not found: <method> <url>`) |

Incoming HTTP headers are forwarded to tools as `ctx.headers`, so a tool can read
per-call metadata (a tenant id, a bearer token) the same way it would over stdio's
static `headers`.

::: warning The HTTP transport is loopback-guarded by default
It binds `127.0.0.1`, and before any dispatch it requires the `Host` hostname to be
a loopback name (anti-DNS-rebinding) and — *when an `Origin` header is present* —
that origin to be a loopback origin (anti-CSRF; browsers always send `Origin` on a
cross-site POST, so its absence means a non-browser client and is allowed). Widen
it deliberately with `allowedHosts` / `allowedOrigins`, or replace the whole check
with `allowRequest`. There is no authentication layer here — this transport is a
dev/CI surface, not a public endpoint.
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
| `allowRequest` | `(origin: string \| undefined, host: string \| undefined) => boolean` | — | Full override — **replaces** the loopback/`allowedHosts`/`allowedOrigins` checks. Returning `true` unconditionally disables the guard |

Returns `Promise<HttpHandle>` — `{ port, url, close() }`.

### `CallContext` — what a transport supplies

You only build this yourself when embedding `handleMessage` in your own transport.

| Field | Type | Supplied by | Purpose |
| --- | --- | --- | --- |
| `headers` | `Record<string, string \| string[] \| undefined>` | stdio (`options.headers`), HTTP (request headers) | Forwarded verbatim to `ctx.headers` in tools |
| `progress` | `(u: ProgressUpdate) => void` | you | An explicit progress sink; takes precedence over the `progressToken` + `notify` pairing |
| `elicit` | `(prompt: string) => Promise<boolean>` | you | Ask the client to confirm; surfaces as `ctx.elicit` |
| `notify` | `(message: JsonRpcRequest) => void` | stdio | Push server→client notifications. Without it, `progressToken` progress is dropped |
| `signal` | `AbortSignal` | you | An external abort linked into the per-request controller |

## Failure modes & troubleshooting

| Message | Code | Where | When |
| --- | --- | --- | --- |
| `Parse error` | `-32700` | stdio line, HTTP body | The message wasn't valid JSON. HTTP answers `400`; stdio replies with id `null` |
| `Invalid JSON-RPC request` | `-32600` | `handleMessage` | `jsonrpc !== '2.0'` or `method` isn't a string |
| `Forbidden: host/origin not allowed` | `-32600` (HTTP `403`) | `serveHttp` guard | Foreign `Host` or `Origin`; rejected before any dispatch |
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
  registered under a non-null request id, and your `invoke` must actually observe
  `ctx.signal`. A tight synchronous loop will never notice it.
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
