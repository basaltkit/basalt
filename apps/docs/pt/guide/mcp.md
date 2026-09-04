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

[[toc]]

## Onde o MCP se encaixa

Quatro pacotes falam MCP, cada um com uma função — esta página é a última linha:

| Camada | Pacote | Função | Runtime? |
| --- | --- | --- | --- |
| Inteligência | [`@basaltkit/ai`](./ai) | O CLI `basalt ai`: analyze, doctor, plan, make, review | só-dev |
| Ponte de dev | [`@basaltkit/ai-mcp`](./ai-mcp) | Expõe esses fluxos de desenvolvimento ao teu editor por MCP | só-dev |
| Fio | [`@basaltkit/mcp-core`](./mcp-core) | Protocolo sem dependências + servidor genérico + transportes | partilhado |
| Superfície runtime | **`@basaltkit/mcp`** | **Esta página** — rotas com opt-in tornam-se tools para agentes | runtime |

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

::: warning Os guards aplicam-se — e têm de ser aplicáveis
Uma rota com `meta.auth` (ou `meta.can` / `meta.teamRole`) mantém esse guard
quando é invocada como tool: uma `tools/call` sem autenticação recebe o mesmo
corpo de erro `UNAUTHORIZED` que um pedido HTTP sem autenticação, transportado no
resultado da tool com `isError: true`. O reverso: se alguma rota declarar
`meta.auth` e nenhum `authPlugin` estiver registado, a app **recusa arrancar**
com `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) — vê
[Segurança](/pt/guide/security). Por HTTP, envia os headers `Authorization` /
tenant no pedido `POST /mcp`; por stdio, passa `headers` estáticos ao
`serveMcpStdio`.
:::

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

A conversão de schemas usa o `z.toJSONSchema` do próprio Zod, portanto o schema
de entrada de uma tool é descrito ao cliente tal como o Zod o descreve. **É
preciso Zod 4** — vê a nota sobre a peer dependency no README do pacote.

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

## Referência de opções

As tabelas abaixo são as opções públicas completas dos quatro pontos de entrada.

### `mcpPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `routes` | `BasaltRoute[]` | — (obrigatório) | As rotas analisadas à procura de `meta.mcp` — tipicamente o mesmo array que passas ao adaptador |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt', version: '0.1.0' }` | O que o `initialize` reporta aos clientes |
| `filter` | `(route: BasaltRoute) => boolean` | expõe todas as rotas com opt-in | Um portão ao nível do deployment por cima do `meta.mcp` (ex.: esconder rotas de admin num ambiente) |

### `mcpRoutes(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `path` | `string` | `'/mcp'` | Onde o endpoint POST de JSON-RPC é montado |
| `rateLimit` | `{ limit: number; windowMs: number }` | nenhum | Aplica `meta.rateLimit` ao `/mcp` (imposto pelo `securityPlugin` num bucket dedicado) — o **único** rate limit que se aplica a chamadas de tools |

### `serveMcpStdio(app, options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Headers estáticos aplicados a **todas** as chamadas de tools — o stdio não tem headers por pedido, é assim que um agente local leva um token/tenant de serviço |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Injeta um stream nos testes |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Injeta um sink nos testes |

Devolve um handle cujo `close()` desliga o listener do stdin.

### `mcpClientPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `servers` | `Record<string, { type: 'http'; url; headers? } \| { type: 'stdio'; command; args?; env?; cwd? }>` | — (obrigatório) | Servidores externos nomeados registados sob `MCP_CLIENTS` |
| `eager` | `boolean` | `true` | Ligar todos os servidores no arranque (falhar cedo) vs. lazily no primeiro `callTool`/`listTools` |

## Modos de falha e resolução de problemas

Falhas ao nível da tool **não** são erros de protocolo: um erro de
handler/guard/validação volta como um resultado normal com `isError: true`, cujo
texto é o mesmo corpo de erro que o HTTP teria devolvido (ex.:
`{ "code": "UNAUTHORIZED", … }`). Erros de protocolo usam códigos JSON-RPC:

| Sintoma | Causa | Correção |
| --- | --- | --- |
| O arranque lança `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) | Uma rota declara `meta.auth`/`meta.can`/`meta.teamRole` e nenhum plugin o impõe | Regista `authPlugin` / `permissionsPlugin` / `teamsPlugin` — vê [Segurança](/pt/guide/security) |
| `isError: true` com um corpo `UNAUTHORIZED`/`FORBIDDEN` | A rota da tool está guardada e a chamada não levou credenciais (ou levou más) | Envia headers `Authorization`/tenant com o `POST /mcp`, ou `serveMcpStdio(app, { headers })` |
| JSON-RPC `-32602` `Unknown tool: …` | Nome de tool não registado — rota sem `meta.mcp`, excluída pelo `filter`, ou renomeada | Verifica o `tools/list`; lembra os overrides via `meta.mcp.name` |
| JSON-RPC `-32601` `Method not found` | O cliente chamou um método MCP que o servidor não implementa | Só existem `initialize`, `ping`, `tools/list`, `tools/call` (mais resources/prompts quando registados) |
| Uma tool ignora o `meta.rateLimit` da sua rota | Os rate limits por rota pertencem ao registo HTTP direto da rota — **não** se aplicam através do `/mcp` | Orçamenta o tráfego de tools com `mcpRoutes({ rateLimit })` |
| O Claude Desktop mostra um servidor morto/quebrado | Algo imprimiu no stdout — ele é o canal JSON-RPC | `logLevel: 'silent'`, remove `console.log`; vê a checklist de stdio acima |
| Resposta `202` do `POST /mcp` com corpo vazio | A mensagem era uma *notificação* JSON-RPC — por spec não recebe resposta | Comportamento esperado, não é um erro |

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
