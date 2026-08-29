# MCP (Model Context Protocol)

`@basaltkit/mcp` turns a Basalt app into an [MCP](https://modelcontextprotocol.io)
server — and lets it act as a client. Opt-in routes become tools an AI agent can
call, over **HTTP (any adapter)** or **stdio**. Crucially, a tool call runs
through the *same* neutral request pipeline as HTTP, so **validation, tenancy and
auth apply unchanged** — MCP is just another way in, not a bypass.

::: tip Runtime, not codegen
This is a **runtime** package: it exposes *your app's routes* to agents in
production. It's separate from the dev-only [`@basaltkit/ai`](./ai) /
[`@basaltkit/ai-mcp`](./ai-mcp) layer (which exposes *dev workflows* to your
editor), and it's built on the zero-dependency [`@basaltkit/mcp-core`](./mcp-core).
Basalt speaks MCP's JSON-RPC directly — no external SDK.
:::

[[toc]]

## Where MCP fits

Four packages speak MCP, each with one job — this page is the last row:

| Layer | Package | Role | Runtime? |
| --- | --- | --- | --- |
| Intelligence | [`@basaltkit/ai`](./ai) | The `basalt ai` CLI: analyze, doctor, plan, make, review | dev-only |
| Dev bridge | [`@basaltkit/ai-mcp`](./ai-mcp) | Exposes those dev workflows to your editor over MCP | dev-only |
| Wire | [`@basaltkit/mcp-core`](./mcp-core) | Zero-dependency protocol + generic server + transports | shared |
| Runtime surface | **`@basaltkit/mcp`** | **This page** — opt-in routes become tools for agents | runtime |

## Expose routes as tools

Opt a route in with `meta.mcp`, register `mcpPlugin`, and add `mcpRoutes()` to
your adapter:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify' // or express / hono
import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'
import { route } from '@basaltkit/http'
import { z } from 'zod'

const routes = [
  route({
    method: 'POST', url: '/projects',
    meta: { mcp: true },                       // → tool `post_projects`
    body: z.object({ name: z.string().min(3) }),
    async handler({ body }) { return db.projects.create(body) },
  }),
  route({
    method: 'GET', url: '/projects/:id',
    meta: { mcp: { name: 'get_project', description: 'Fetch a project by id' } },
    params: z.object({ id: z.string() }),
    async handler({ params }) { return db.projects.find(params.id) },
  }),
]

await createApp({
  plugins: [
    mcpPlugin({ routes, serverInfo: { name: 'my-app', version: '1.0.0' } }),
    fastifyPlugin({ routes: [...routes, ...mcpRoutes()] }), // POST /mcp
  ],
}).boot()
```

- **Opt-in only** — routes without `meta.mcp` are never exposed. `meta.mcp` is
  either `true` or `{ name?, description? }`.
- **Input schema** is generated from the route's `params` + `query` + `body` Zod
  schemas, merged into one flat object.
- **Same pipeline** — a `tools/call` runs enrichers, guards and validation before
  the handler; request headers (tenant, authorization) propagate into the call.

::: warning Guards apply — and must be enforceable
A route with `meta.auth` (or `meta.can` / `meta.teamRole`) keeps that guard when
invoked as a tool: an unauthenticated `tools/call` gets the same `UNAUTHORIZED`
error body as an unauthenticated HTTP request, carried in the tool result with
`isError: true`. The flip side: if any route declares `meta.auth` and no
`authPlugin` is registered, the app **refuses to boot** with
`UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) — see
[Security](/guide/security). Over HTTP, pass `Authorization` / tenant headers on
the `POST /mcp` request; over stdio, pass static `headers` to `serveMcpStdio`.
:::

## Tool schemas & arguments

**Tool names** come from the route's method and path: `GET /skills` →
`get_skills`, `GET /skills/:id` → `get_skills_by_id`, `POST /skills` →
`post_skills`. Override with `meta: { mcp: { name: 'my_tool' } }`.

**Input schema** is generated from the route's `params`, `query` and `body` Zod
schemas, merged into one flat object with the right `required` fields — so the
client knows exactly what to send.

**Argument coercion.** MCP clients and LLMs frequently send numbers and booleans
as *strings* (`"7"`, `"true"`). Before validation the bridge coerces each
argument to the scalar type its Zod field declares, so a `z.number()` field
accepts `"7"` and receives `7`. Non-coercible strings are left as-is so genuine
validation errors still surface.

**Structured output.** A tool result always carries the handler's return value as
text (`content`), and — **only when that value is a JSON object** — also as
`structuredContent`. Handlers returning a top-level array or primitive (e.g. a
list endpoint) put the data in `content` only, because MCP requires
`structuredContent` to be an object.

**Zod 3 and 4** are both supported; on Zod 4 the schema conversion uses Zod's
native `z.toJSONSchema`.

## stdio & Claude Desktop

For local agents (Claude Desktop, IDEs), serve the same server over stdio. Use a
**dedicated entry** — not your HTTP `server.ts` — that boots the app and serves
stdio, with **no HTTP `listen` and nothing printed to stdout**:

```ts
// src/mcp-stdio.ts
import { serveMcpStdio } from '@basaltkit/mcp'
import { buildApp } from './app.js'

const app = await buildApp({ logLevel: 'silent' }).boot() // includes mcpPlugin
serveMcpStdio(app) // newline-delimited JSON-RPC on stdin/stdout
```

Wire Claude Desktop to it (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "my-app": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/mcp-stdio.js"]
    }
  }
}
```

Getting this right in practice:

- **Build first.** Claude Desktop runs the compiled `dist/mcp-stdio.js`, so run
  your build after every change. For a dev loop, run the TS entry with
  `node --import tsx src/mcp-stdio.ts` instead.
- **Use an absolute `node` path.** GUI apps on macOS don't inherit your shell
  PATH, so `node`/`npx`/`pnpm` may not be found — point `command` at the absolute
  binary (from `which node`).
- **Keep stdout clean.** stdout is the JSON-RPC channel: set `logLevel: 'silent'`
  and remove any `console.log` in your handlers — one stray line corrupts the
  protocol.
- **Load your env.** The spawned process has no shell, so load your `.env` (Node's
  `process.loadEnvFile()`, or pass vars via the config's `env` field), and make
  sure the DB/services the app boots against are reachable.
- **A silent stdio server is normal.** Run alone it just waits for input — it is
  meant to be spawned by a client, not run by hand. Pipe a message to check it:
  `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-stdio.js`.

## Consume external MCP servers (client)

The runtime side of *server + client* — point a client at any MCP server:

```ts
import { McpClient, HttpClientTransport, StdioClientTransport } from '@basaltkit/mcp'

const client = new McpClient(new HttpClientTransport('https://host/mcp'))
await client.connect()
const { tools } = await client.listTools()
const result = await client.callTool('get_project', { id: 'p1' })

// …or spawn a stdio server
const local = new McpClient(new StdioClientTransport({ command: 'some-mcp-server' }))
await local.connect()
```

### Register servers with a plugin

`mcpClientPlugin` wires named external servers into the container — it connects
them at boot and closes them on shutdown, so any part of the app can use their
tools through the `MCP_CLIENTS` registry:

```ts
import { mcpClientPlugin, MCP_CLIENTS } from '@basaltkit/mcp'

createApp({
  plugins: [
    mcpClientPlugin({
      servers: {
        search: { type: 'http', url: 'https://search.example/mcp' },
        files: { type: 'stdio', command: 'mcp-files', args: ['--root', '.'] },
      },
    }),
  ],
})

// anywhere with the container:
const clients = container.get(MCP_CLIENTS)
const { tools } = await clients.listTools('search')
const result = await clients.callTool('search', 'query', { q: 'basalt' })
```

Connections are lazy-safe: `callTool` / `listTools` connect on demand, so
`eager: false` defers connecting until first use.

## Transports

| Transport | Server | Client | Adapters |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | fastify · express · hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | local process |

The HTTP transport is a neutral `route()`, verified on all three adapters — the
same tool surface regardless of the server underneath.

On an exposed deployment, give `/mcp` its own rate-limit budget:
`mcpRoutes({ rateLimit: { limit: 30, windowMs: 60_000 } })` stamps
`meta.rateLimit` on the route, and `securityPlugin` enforces it in a dedicated
bucket. Note that a tool route's own `meta.rateLimit` belongs to its direct HTTP
registration — it is not applied when the route is invoked as a tool through
`/mcp`, so the `/mcp` budget is the throttle for tool traffic. (Auth and guards
DO run identically on both paths.)


## Options reference

The tables below are the complete public options of the four entry points.

### `mcpPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `routes` | `BasaltRoute[]` | — (required) | The routes scanned for `meta.mcp` — typically the same array you pass the adapter |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt', version: '0.1.0' }` | What `initialize` reports to clients |
| `filter` | `(route: BasaltRoute) => boolean` | expose every opted-in route | A deployment-level gate on top of `meta.mcp` (e.g. hide admin routes in one environment) |

### `mcpRoutes(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `path` | `string` | `'/mcp'` | Where the JSON-RPC POST endpoint mounts |
| `rateLimit` | `{ limit: number; windowMs: number }` | none | Stamps `meta.rateLimit` on `/mcp` (enforced by `securityPlugin` in a dedicated bucket) — the **only** rate limit that applies to tool calls |

### `serveMcpStdio(app, options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Static headers applied to **every** tool call — stdio has no per-request headers, so this is how a local agent carries a service token/tenant |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Inject a stream in tests |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Inject a sink in tests |

Returns a handle whose `close()` detaches the stdin listener.

### `mcpClientPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `servers` | `Record<string, { type: 'http'; url; headers? } \| { type: 'stdio'; command; args?; env?; cwd? }>` | — (required) | Named external servers registered under `MCP_CLIENTS` |
| `eager` | `boolean` | `true` | Connect all servers at boot (fail fast) vs. lazily on first `callTool`/`listTools` |

## Failure modes & troubleshooting

Tool-level failures are **not** protocol errors: a handler/guard/validation
error comes back as a normal result with `isError: true`, whose text is the same
error body HTTP would have returned (e.g. `{ "code": "UNAUTHORIZED", … }`).
Protocol errors use JSON-RPC codes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot throws `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) | A route declares `meta.auth`/`meta.can`/`meta.teamRole` and no plugin enforces it | Register `authPlugin` / `permissionsPlugin` / `teamsPlugin` — see [Security](/guide/security) |
| `isError: true` with an `UNAUTHORIZED`/`FORBIDDEN` body | The tool's route is guarded and the call carried no (or bad) credentials | Send `Authorization`/tenant headers with `POST /mcp`, or `serveMcpStdio(app, { headers })` |
| JSON-RPC `-32602` `Unknown tool: …` | Tool name not registered — route missing `meta.mcp`, excluded by `filter`, or renamed | Check `tools/list`; remember overrides via `meta.mcp.name` |
| JSON-RPC `-32601` `Method not found` | The client called an MCP method the server doesn't implement | Only `initialize`, `ping`, `tools/list`, `tools/call` (plus resources/prompts when registered) exist |
| A tool ignores its route's `meta.rateLimit` | Per-route rate limits belong to the route's own HTTP registration — they do **not** apply through `/mcp` | Budget tool traffic with `mcpRoutes({ rateLimit })` |
| Claude Desktop shows a broken/dead server | Something printed to stdout — it is the JSON-RPC channel | `logLevel: 'silent'`, remove `console.log`; see the stdio checklist above |
| `202` response from `POST /mcp` with empty body | The message was a JSON-RPC *notification* — by spec it gets no reply | Expected behaviour, not an error |

## Testing with the MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) connects
to your server and lets you list and call tools interactively — a visual studio
for MCP:

```bash
# Web UI (opens a browser):
npx @modelcontextprotocol/inspector /absolute/node dist/mcp-stdio.js

# Headless CLI:
npx @modelcontextprotocol/inspector --cli /absolute/node dist/mcp-stdio.js --method tools/list
npx @modelcontextprotocol/inspector --cli /absolute/node dist/mcp-stdio.js \
  --method tools/call --tool-name get_skills
```

Over HTTP, point it at your `POST /mcp` endpoint instead.

## Try it in the playground

The repo's [`apps/playground`](https://github.com/basaltkit/basalt/tree/main/apps/playground)
opts three routes into MCP — `create_project`, `list_projects`, `get_project` —
and ships a stdio entry. Point Claude Desktop at it:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "basalt-playground": {
      "command": "pnpm",
      "args": ["--filter", "playground", "mcp:stdio"]
    }
  }
}
```

Logging is silenced in that entry because stdout is the JSON-RPC channel. Over
HTTP, the same tools are at `POST /mcp` once the server is running.
