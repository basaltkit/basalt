# MCP (Model Context Protocol)

`@basaltkit/mcp` turns a Basalt app into an [MCP](https://modelcontextprotocol.io)
server — and lets it act as a client. Opt-in routes become tools an AI agent can
call, over **HTTP (any adapter)** or **stdio**. Crucially, a tool call runs
through the *same* neutral request pipeline as HTTP, so **validation, tenancy and
auth apply unchanged** — MCP is just another way in, not a bypass.

::: tip Runtime, not codegen
This is a **runtime** package, separate from the dev-only [`@basaltkit/ai`](./ai)
layer. Basalt speaks MCP's JSON-RPC directly — no external SDK.
:::

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

## stdio

For local agents (Claude Desktop, IDEs), serve the same server over stdio:

```ts
import { serveMcpStdio } from '@basaltkit/mcp'

const app = await buildApp().boot() // includes mcpPlugin
serveMcpStdio(app)                  // newline-delimited JSON-RPC on stdin/stdout
```

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

## Transports

| Transport | Server | Client | Adapters |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | fastify · express · hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | local process |

The HTTP transport is a neutral `route()`, verified on all three adapters — the
same tool surface regardless of the server underneath.


## Try it in the playground

The repo's [`apps/playground`](https://github.com/Zebedeu/basalt/tree/main/apps/playground)
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
