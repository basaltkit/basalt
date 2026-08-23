# MCP (Model Context Protocol)

O `@basaltkit/mcp` transforma uma app Basalt num servidor [MCP](https://modelcontextprotocol.io)
— e permite-lhe agir como cliente. As rotas com opt-in tornam-se tools que um
agente de IA pode chamar, por **HTTP (qualquer adaptador)** ou **stdio**. O ponto
essencial: uma chamada de tool passa pelo *mesmo* pipeline neutro de pedidos que o
HTTP, portanto **validação, tenancy e auth aplicam-se sem alteração** — o MCP é
mais uma porta de entrada, não um atalho que as ignora.

::: tip Runtime, não codegen
Este é um pacote **runtime**, separado da camada dev-only [`@basaltkit/ai`](./ai).
O Basalt fala o JSON-RPC do MCP diretamente — sem SDK externo.
:::

## Expor rotas como tools

Marca uma rota com `meta.mcp`, regista o `mcpPlugin` e adiciona `mcpRoutes()` ao
teu adaptador:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify' // ou express / hono
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
    meta: { mcp: { name: 'get_project', description: 'Buscar um projeto por id' } },
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

- **Só opt-in** — rotas sem `meta.mcp` nunca são expostas. `meta.mcp` é `true` ou
  `{ name?, description? }`.
- **O input schema** é gerado a partir dos schemas Zod `params` + `query` + `body`
  da rota, fundidos num único objeto plano.
- **Mesmo pipeline** — uma `tools/call` corre enrichers, guards e validação antes
  do handler; os headers do pedido (tenant, authorization) propagam para a chamada.

## stdio

Para agentes locais (Claude Desktop, IDEs), serve o mesmo servidor por stdio:

```ts
import { serveMcpStdio } from '@basaltkit/mcp'

const app = await buildApp().boot() // inclui o mcpPlugin
serveMcpStdio(app)                  // JSON-RPC delimitado por newline no stdin/stdout
```

## Consumir servidores MCP externos (cliente)

O lado runtime de *servidor + cliente* — aponta um cliente a qualquer servidor MCP:

```ts
import { McpClient, HttpClientTransport, StdioClientTransport } from '@basaltkit/mcp'

const client = new McpClient(new HttpClientTransport('https://host/mcp'))
await client.connect()
const { tools } = await client.listTools()
const result = await client.callTool('get_project', { id: 'p1' })

// …ou lança um servidor stdio
const local = new McpClient(new StdioClientTransport({ command: 'some-mcp-server' }))
await local.connect()
```

## Transportes

| Transporte | Servidor | Cliente | Adaptadores |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | fastify · express · hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | processo local |

O transporte HTTP é um `route()` neutro, verificado nos três adaptadores — a mesma
superfície de tools independentemente do servidor por baixo.
