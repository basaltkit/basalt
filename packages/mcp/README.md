# @basaltkit/mcp

Turn a Basalt app into a [Model Context Protocol](https://modelcontextprotocol.io)
server — and let it act as an MCP client. Opt-in routes become tools that AI
agents can call, over **HTTP (any adapter)** or **stdio**. Tool calls run through
the *same* neutral request pipeline as HTTP, so validation, tenancy and auth all
apply unchanged.

This is a **runtime** package — distinct from the dev-only `@basaltkit/ai`
codegen layer. No external SDK; Basalt speaks MCP's JSON-RPC directly.

## Server — expose routes as tools

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
    meta: { mcp: true }, // ← exposed as the tool `post_projects`
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

- **Opt-in only**: routes without `meta.mcp` are never exposed.
- **Input schema**: built automatically from the route's `params` + `query` +
  `body` Zod schemas (merged into one flat object).
- **Same pipeline**: a `tools/call` runs enrichers, guards and validation, then
  the handler — request headers (tenant, authorization) propagate into the call.

### stdio

For local agents (Claude Desktop, IDEs), serve the same server over stdio:

```ts
import { serveMcpStdio } from '@basaltkit/mcp'

const app = await buildApp().boot() // includes mcpPlugin
serveMcpStdio(app) // newline-delimited JSON-RPC on stdin/stdout
```

## Client — consume external MCP servers

```ts
import { McpClient, HttpClientTransport, StdioClientTransport } from '@basaltkit/mcp'

// Over HTTP
const client = new McpClient(new HttpClientTransport('https://host/mcp'))
await client.connect()
const { tools } = await client.listTools()
const result = await client.callTool('get_project', { id: 'p1' })

// Or spawn a stdio server
const local = new McpClient(new StdioClientTransport({ command: 'some-mcp-server', args: [] }))
await local.connect()
```

## Transports

| Transport | Server | Client | Adapter-agnostic |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | ✅ fastify / express / hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | n/a (local process) |

## Tests

`pnpm --filter @basaltkit/mcp test` — protocol conformance, an HTTP round-trip on
**all three adapters** (client → server → route handler, with tenancy), and stdio
server + client round-trips.
