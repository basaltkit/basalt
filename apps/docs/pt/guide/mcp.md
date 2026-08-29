# MCP (Model Context Protocol)

O `@basaltkit/mcp` transforma uma app Basalt num servidor [MCP](https://modelcontextprotocol.io)
— e permite-lhe agir como cliente. As rotas com opt-in tornam-se tools que um
agente de IA pode chamar, por **HTTP (qualquer adaptador)** ou **stdio**. O ponto
essencial: uma chamada de tool passa pelo *mesmo* pipeline neutro de pedidos que o
HTTP, portanto **validação, tenancy e auth aplicam-se sem alteração** — o MCP é
mais uma porta de entrada, não um atalho que as ignora.

::: tip Runtime, não codegen
Este é um pacote **runtime**: expõe *as rotas da tua app* a agentes em produção. É
separado da camada só-de-dev [`@basaltkit/ai`](./ai) / [`@basaltkit/ai-mcp`](./ai-mcp)
(que expõe *fluxos de desenvolvimento* ao teu editor) e é construído sobre o
[`@basaltkit/mcp-core`](./mcp-core) (sem dependências). O Basalt fala o JSON-RPC do
MCP diretamente — sem SDK externo.
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

## Schemas e argumentos das tools

**Os nomes das tools** vêm do método e do path da rota: `GET /skills` →
`get_skills`, `GET /skills/:id` → `get_skills_by_id`, `POST /skills` →
`post_skills`. Substitui com `meta: { mcp: { name: 'my_tool' } }`.

**O input schema** é gerado dos schemas Zod `params`, `query` e `body` da rota,
fundidos num objeto plano com os `required` certos — para o cliente saber
exatamente o que enviar.

**Coerção de argumentos.** Os clientes MCP e os LLMs enviam frequentemente
números e booleanos como *strings* (`"7"`, `"true"`). Antes da validação, o
bridge coage cada argumento para o tipo escalar que o campo Zod declara, por isso
um campo `z.number()` aceita `"7"` e recebe `7`. Strings não-coercíveis ficam
como estão, para que erros de validação genuínos continuem a aparecer.

**Saída estruturada.** Um resultado de tool leva sempre o valor de retorno do
handler como texto (`content`) e — **só quando esse valor é um objeto JSON** —
também como `structuredContent`. Handlers que devolvem um array ou primitivo no
topo (ex. um endpoint de lista) põem os dados só no `content`, porque o MCP exige
que o `structuredContent` seja um objeto.

**Zod 3 e 4** são ambos suportados; no Zod 4 a conversão usa o `z.toJSONSchema`
nativo do Zod.

## stdio e Claude Desktop

Para agentes locais (Claude Desktop, IDEs), serve o mesmo servidor por stdio. Usa
uma **entrada dedicada** — não o teu `server.ts` HTTP — que arranca a app e serve
stdio, **sem `listen` HTTP e sem imprimir nada no stdout**:

```ts
// src/mcp-stdio.ts
import { serveMcpStdio } from '@basaltkit/mcp'
import { buildApp } from './app.js'

const app = await buildApp({ logLevel: 'silent' }).boot() // inclui o mcpPlugin
serveMcpStdio(app) // JSON-RPC delimitado por newline no stdin/stdout
```

Liga o Claude Desktop a ela (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "my-app": {
      "command": "/caminho/absoluto/para/node",
      "args": ["/caminho/absoluto/para/dist/mcp-stdio.js"]
    }
  }
}
```

Para acertar na prática:

- **Compila primeiro.** O Claude Desktop corre o `dist/mcp-stdio.js` compilado,
  por isso corre o build depois de cada mudança. Para um loop de dev, corre a
  entrada TS com `node --import tsx src/mcp-stdio.ts`.
- **Usa o caminho absoluto do `node`.** As apps GUI no macOS não herdam o PATH da
  shell, por isso `node`/`npx`/`pnpm` podem não ser encontrados — aponta o
  `command` para o binário absoluto (do `which node`).
- **Mantém o stdout limpo.** O stdout é o canal JSON-RPC: define
  `logLevel: 'silent'` e remove qualquer `console.log` dos handlers — uma linha
  perdida corrompe o protocolo.
- **Carrega o teu env.** O processo lançado não tem shell, por isso carrega o
  `.env` (o `process.loadEnvFile()` do Node, ou passa as vars pelo campo `env` da
  config), e garante que a BD/serviços que a app arranca estão acessíveis.
- **Um servidor stdio silencioso é normal.** Sozinho fica só à espera de input —
  é para ser lançado por um cliente, não corrido à mão. Envia-lhe uma mensagem
  para verificar:
  `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-stdio.js`.

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

### Registar servidores com um plugin

O `mcpClientPlugin` liga servidores externos nomeados ao container — conecta-os no
arranque e fecha-os no shutdown, para que qualquer parte da app possa usar as suas
tools através do registry `MCP_CLIENTS`:

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

// em qualquer lado com o container:
const clients = container.get(MCP_CLIENTS)
const { tools } = await clients.listTools('search')
const result = await clients.callTool('search', 'query', { q: 'basalt' })
```

As ligações são lazy-safe: `callTool` / `listTools` conectam a pedido, por isso
`eager: false` adia a ligação até ao primeiro uso.

## Transportes

| Transporte | Servidor | Cliente | Adaptadores |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | fastify · express · hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | processo local |

O transporte HTTP é um `route()` neutro, verificado nos três adaptadores — a mesma
superfície de tools independentemente do servidor por baixo.


Num deployment exposto, dá ao `/mcp` o seu próprio orçamento de rate limit:
`mcpRoutes({ rateLimit: { limit: 30, windowMs: 60_000 } })` aplica
`meta.rateLimit` à rota, e o `securityPlugin` impõe-no num bucket dedicado.
Nota que o `meta.rateLimit` próprio de uma rota-ferramenta pertence ao seu
registo HTTP direto — não é aplicado quando a rota é invocada como tool através
do `/mcp`, portanto o orçamento do `/mcp` é o throttle do tráfego de tools.
(Auth e guards correm de forma idêntica em ambos os caminhos.)

## Testar com o MCP Inspector

O [MCP Inspector](https://github.com/modelcontextprotocol/inspector) liga-se ao
teu servidor e deixa-te listar e chamar tools interativamente — um studio visual
para MCP:

```bash
# UI web (abre o browser):
npx @modelcontextprotocol/inspector /node/absoluto dist/mcp-stdio.js

# CLI headless:
npx @modelcontextprotocol/inspector --cli /node/absoluto dist/mcp-stdio.js --method tools/list
npx @modelcontextprotocol/inspector --cli /node/absoluto dist/mcp-stdio.js \
  --method tools/call --tool-name get_skills
```

Por HTTP, aponta-o ao teu endpoint `POST /mcp`.

## Experimenta no playground

O [`apps/playground`](https://github.com/basaltkit/basalt/tree/main/apps/playground)
do repositório marca três rotas para MCP — `create_project`, `list_projects`,
`get_project` — e traz uma entrada stdio. Aponta o Claude Desktop para ela:

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

O logging está silenciado nessa entrada porque o stdout é o canal JSON-RPC. Por
HTTP, as mesmas tools ficam em `POST /mcp` com o servidor a correr.
