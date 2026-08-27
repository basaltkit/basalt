# Building an MCP server (`@basaltkit/mcp-core`)

`@basaltkit/mcp-core` is the **zero-dependency** wire underneath Basalt's MCP
story: the JSON-RPC 2.0 + [Model Context Protocol](https://modelcontextprotocol.io)
types, a transport-neutral server that dispatches over **function-shaped**
tools / resources / prompts (with progress + cancellation), and **stdio** and
**HTTP** transports. It has no runtime dependencies — no `@basaltkit/core`, no
`@basaltkit/http`, no external SDK.

::: tip Which MCP package do I want?
- Exposing **your app's routes** to agents in production → [`@basaltkit/mcp`](./mcp)
  (routes become tools through the neutral pipeline; tenancy/auth apply).
- Exposing **Basalt dev workflows** to your editor → [`@basaltkit/ai-mcp`](./ai-mcp).
- Building **your own** MCP server from arbitrary functions, with no framework
  runtime in the graph → **this package.**

`@basaltkit/mcp` and `@basaltkit/ai-mcp` are both built on `mcp-core`.
:::

[[toc]]

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
JSON-RPC surface: `initialize`, `ping`, `tools/list`, `tools/call`, and — when you
register them — `resources/list`, `resources/read`, `prompts/list`, `prompts/get`.

Capabilities are advertised **only when present**: a tools-only server reports
`{ tools: { listChanged: false } }`; register resources or prompts and the
matching capability appears. Unknown methods return `METHOD_NOT_FOUND`; malformed
requests `INVALID_REQUEST`; a thrown tool error surfaces as `INTERNAL_ERROR`
(while a *tool-level* failure rides in the result as `isError`, not a protocol
error).

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

- **Progress** — when a `tools/call` carries `params._meta.progressToken` and the
  transport can push notifications, `ctx.progress(...)` emits
  `notifications/progress` with that token.
- **Cancellation** — each in-flight call gets a per-request `AbortController`.
  A `notifications/cancelled` with the matching `requestId` aborts `ctx.signal`.

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

`resources/read` returns `{ contents: [{ uri, mimeType?, text }] }`, defaulting
`uri`/`mimeType` from the descriptor. An unknown URI fails `INVALID_PARAMS`.

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

Newline-delimited JSON-RPC. Supports server→client notifications (progress),
notifications get no reply, and a parse error returns a JSON-RPC parse error.

### HTTP (opt-in)

```ts
import { serveHttp } from '@basaltkit/mcp-core'

const http = await serveHttp(server, { port: 0, host: '127.0.0.1', path: '/mcp' })
console.log(http.url)   // http://127.0.0.1:<port>/mcp
await http.close()
```

A minimal `node:http` server — `POST` JSON-RPC to `path`, one request/response per
call (no SSE), `202` for notifications, `400`/`404` for bad body / off-path. It
uses only `node:http`, so a dev-only server keeps the framework runtime out of its
graph.

## Protocol details

```ts
import {
  SUPPORTED_PROTOCOL_VERSIONS, // ['2025-06-18', '2025-03-26', '2024-11-05']
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,                  // PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, …
  negotiateVersion,            // honour the client's version if supported, else latest
} from '@basaltkit/mcp-core'
```

`initialize` negotiates the protocol version (`negotiateVersion`) and returns the
server's capabilities + `serverInfo`. Basalt speaks MCP directly — there is no SDK
dependency, and the same `handleMessage` drives every transport.

## Contrast: `mcp-core` vs runtime `@basaltkit/mcp`

| | `@basaltkit/mcp-core` | [`@basaltkit/mcp`](./mcp) |
| --- | --- | --- |
| Tools are… | arbitrary **functions** (`McpToolDef`) | opt-in **routes** (`meta.mcp`) |
| Dependencies | **zero** | `@basaltkit/core` + `@basaltkit/http` |
| Runs through | your `invoke` | the neutral request pipeline (tenancy/auth) |
| Use when | building a standalone/dev MCP server | exposing an app's API to agents |

Reach for `mcp-core` when you want a small, framework-free MCP server (a dev tool,
a CLI companion, a bespoke agent surface). Reach for `@basaltkit/mcp` when the
tools *are* your app's endpoints and should honour the same validation, tenancy
and auth as HTTP.

## See also

- [`@basaltkit/ai-mcp`](./ai-mcp) — the dev bridge built on this package.
- [MCP (runtime)](./mcp) — routes as tools, in production.
- Source: `packages/mcp-core/src/**` (`protocol.ts`, `server.ts`, `stdio.ts`, `http.ts`).
