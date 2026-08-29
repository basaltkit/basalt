<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/mcp

Turn a Basalt app into a [Model Context Protocol](https://modelcontextprotocol.io)
server — and let it act as an MCP client. Opt-in routes become tools that AI
agents can call, over **HTTP (any adapter)** or **stdio**. Tool calls run through
the *same* neutral request pipeline as HTTP, so validation, tenancy and auth all
apply unchanged.

This is a **runtime** package — distinct from the dev-only `@basaltkit/ai`
codegen layer. No external SDK; Basalt speaks MCP's JSON-RPC directly.

> **Status: 1.0 (stable).** Server and client, over both HTTP and stdio, are
> settled and covered by semver: breaking changes land only in a new major.

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

Or register named servers with a plugin — `mcpClientPlugin` connects them at boot
and exposes them via the `MCP_CLIENTS` registry:

```ts
import { mcpClientPlugin, MCP_CLIENTS } from '@basaltkit/mcp'

createApp({ plugins: [mcpClientPlugin({ servers: {
  search: { type: 'http', url: 'https://search.example/mcp' },
  files:  { type: 'stdio', command: 'mcp-files', args: ['--root', '.'] },
} })] })

// await container.get(MCP_CLIENTS).callTool('search', 'query', { q: 'basalt' })
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

## Rate limiting `/mcp`

`mcpRoutes({ rateLimit: { limit, windowMs } })` stamps `meta.rateLimit` on the
endpoint so `securityPlugin` enforces a dedicated budget. A tool route's own
`meta.rateLimit` applies to its direct HTTP registration only — not when it is
invoked as a tool through `/mcp` — so this budget is the throttle for tool
traffic.
