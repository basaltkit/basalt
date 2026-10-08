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
  do handler. O pedido da tool herda uma **allowlist** dos headers do chamador
  (`authorization`, `cookie`, `x-api-key`, `x-tenant-id`, `host`,
  `accept-language`, `user-agent` — alarga-a com `mcpPlugin({ forwardHeaders })`),
  o **ip** do cliente (`request.ip`), o `request.routePattern` (o template da rota
  da tool) e o `request.url` concreto (`/projects/p%201?q=x`, não
  `/projects/:id`). Tudo o resto — `x-request-id`, `if-none-match`, headers de
  forwarding e hop-by-hop — é descartado.
- **O status conta** — um handler que responde `reply.code(403)` (qualquer status
  ≥ 400) produz um resultado de tool com `isError: true`.
- **Cancelamento** — `notifications/cancelled` responde de imediato à chamada como
  cancelada; um handler longo pode parar mais cedo verificando
  `toolSignal(request)?.aborted`. Sobre HTTP o cancelamento pode chegar num
  `POST` posterior da mesma [sessão](#sessions-and-cancellation).
- **Listagem filtrada** — o `tools/list` via `/mcp` esconde as tools que o
  chamador estaticamente não pode usar; vê
  [O que o `tools/list` mostra](#what-tools-list-shows).

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

### O que o modelo vê quando uma tool falha {#what-the-model-sees-when-a-tool-fails}

O cliente MCP é um modelo de linguagem — e qualquer pessoa que consiga ler ou
conduzir o seu contexto (uma prompt injection, uma transcrição, um log da
conversa). Trata um resultado de tool como uma resposta enviada a um cliente
não confiável. Quando o handler, um guard ou a validação de uma tool lança, o
resultado leva `isError: true` e o mesmo `{ code, message, details? }` que um
cliente HTTP receberia, com estas fronteiras:

| Canal | Chega ao modelo? | Notas |
| --- | --- | --- |
| `code`, `message` | sim | Um 500 do toolkit ou um erro `expose: false` envia uma mensagem neutra, tal como em HTTP |
| `details` | sim — **redigido** | Sanitizado na forma e depois passado por `redactErrorDetails` (por omissão `redactSensitiveDetails`: o valor de qualquer chave que nomeie um segredo — `password`, `resetToken`, `apiKey`, `secret`, `sessionId`, … — passa a `'[REDACTED]'`; booleanos/`null` mantêm-se) |
| `internalDetails` | **nunca** | Só para o log: entregue a `reportError` (por omissão, o reporter de consola) com o erro intacto |
| stack, cause, texto de exceções inesperadas | nunca | Erros inesperados passam a `INTERNAL_ERROR` |
| um corpo que o teu handler envia (`reply.code(4xx).send(body)`) | sim — **tal e qual** | É o contrato de resposta da rota; aí nada é redigido |

```ts
mcpPlugin({
  routes,
  redactErrorDetails: (details) => ({ failed: details.failed }), // a tua própria allowlist
  reportError: (report) => logger.warn(report, 'tool call failed'),
})

// Por rota: substitui (ou desliga com `false`) só para essa tool.
route({ method: 'POST', url: '/kyc', meta: { mcp: { redactErrorDetails: false } }, handler })
```

A redação é defesa em profundidade, não uma licença: mantém `details` público
por construção e põe os dados só para o operador em `internalDetails`. Os
adapters HTTP não redigem por omissão (o output deles não muda); usa
`toErrorResponse(error, { redactDetails })` no teu próprio adapter ou error
handler para o mesmo filtro.

## Schemas e argumentos das tools

**Os nomes das tools** vêm do método e do path da rota: `GET /skills` →
`get_skills`, `GET /skills/:id` → `get_skills_by_id`, `POST /skills` →
`post_skills`. Substitui com `meta: { mcp: { name: 'my_tool' } }`.

**O input schema** é gerado dos schemas Zod `params`, `query` e `body` da rota,
fundidos num objeto plano com os `required` certos — para o cliente saber
exatamente o que enviar.

**Forma dos argumentos.** O `arguments` tem de ser um objeto JSON (ou ser
omitido). Um array, string, número ou `null` é recusado com JSON-RPC `-32602`
antes de a rota correr, por isso uma chamada malformada nunca chega ao teu
handler nem devolve ao cliente uma exceção interna (como um `TypeError`).

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

Um servidor stdio lançado **não** herda o ambiente da tua app: só uma allowlist
sem segredos (`PATH`, `HOME`, locale, diretórios temporários —
`DEFAULT_INHERITED_ENV`) mais o `env` explícito lhe chegam, por isso
`APP_SECRET`, `DATABASE_URL` e chaves de fornecedores ficam no teu processo. Usa
`inheritEnv: ['GITHUB_TOKEN']` para passar variáveis com nome, ou
`inheritEnv: true` para passar tudo de propósito.

Se o comando não puder ser lançado (`ENOENT`) ou o servidor terminar, as
chamadas em curso são rejeitadas em vez de derrubar o teu processo, e a chamada
seguinte volta a lançá-lo. Um pedido a que o servidor nunca responde é rejeitado
ao fim de `timeoutMs` (por omissão 60 000 ms).

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

Está endurecido para browsers: um pedido cujo `Origin` não seja da mesma origem
nem esteja em `mcpRoutes({ allowedOrigins })` recebe **403**, e o corpo tem de ser
enviado como `application/json` (**415** caso contrário), por isso uma página de
outro site nunca consegue acionar uma tool com os cookies de um visitante.
Clientes que não são browsers não enviam `Origin` e não são afetados. Por
omissão, `initialize` e `tools/list` são anónimos (as *chamadas* de tools correm
na mesma os guards de cada rota); `mcpRoutes({ auth: true })` exige um chamador
autenticado para o próprio endpoint. Batches JSON-RPC são aceites.

### Sessões e cancelamento {#sessions-and-cancellation}

Por omissão, o `/mcp` fala sessões Streamable-HTTP. Um `initialize` bem-sucedido
responde com um header `Mcp-Session-Id`; todos os `POST` seguintes têm de o
levar:

| Pedido | Resposta |
| --- | --- |
| `initialize` | `200` + um novo `Mcp-Session-Id` (um `initialize` falhado não abre nenhuma) |
| qualquer outra mensagem sem o header | **400** — envia primeiro `initialize` |
| um id de sessão desconhecido, expirado ou alheio | **404** — o cliente volta a inicializar (comportamento da spec) |
| `DELETE /mcp` com o header | `204`, a sessão termina (404 se não estava viva) |

Todos os pedidos de uma sessão partilham um âmbito de cancelamento, por isso um
`notifications/cancelled` enviado por `POST` enquanto a chamada corre cancela-a —
e uma sessão diferente, mesmo que adivinhe o id do pedido, nunca consegue. Uma
sessão fica **ligada a quem a abriu**: o `ctx().user` autenticado (no seu tenant)
ou, para um chamador anónimo, uma impressão com chave do seu header
`Authorization` (uma API key aceite pelos plugins de auth já resolveu um
utilizador). O mesmo id apresentado por outra pessoa dá 404. As sessões expiram
após 30 minutos inativas, e há no máximo 1000 vivas em simultâneo (a usada há
mais tempo é despejada — o seu cliente simplesmente volta a inicializar):
`mcpRoutes({ sessions: { ttlMs, maxSessions } })`.

O `HttpClientTransport` (e portanto o `McpClient`/`mcpClientPlugin`) trata do
header por ti e termina a sessão no `close()`.

::: warning As sessões vivem na memória do processo
Atrás de várias réplicas, encaminha uma sessão sempre para a mesma réplica
(sticky sessions por `Mcp-Session-Id`), ou corre sem estado com
`mcpRoutes({ sessions: false })` — cada `POST` passa a ser a sua própria sessão
e um cancelamento só chega a chamadas do mesmo pedido. Um cliente de browser
noutra origem tem de poder ler o header: junta `Mcp-Session-Id` ao
`exposeHeaders` do teu CORS.
:::

### O que o `tools/list` mostra {#what-tools-list-shows}

Com `mcpRoutes({ listVisibleOnly })` (por omissão `true`), o `tools/list` deixa
de fora as tools que o chamador **estaticamente** não pode usar. Só decidem
verificações sem efeitos secundários — os guards das rotas nunca correm numa
listagem, por isso listar não consome rate limit nem escreve registos de
auditoria ou de recusa:

| Escondida quando | Decidido por |
| --- | --- |
| a rota tem `meta.auth` e o chamador não tem `ctx().user` | embutido, quando um guard reivindica `auth` (ex.: `authPlugin`); com uma dispensa de auth na edge nada é escondido |
| a rota tem `meta.teamRole` e o chamador não tem esse papel (ou um superior) no tenant atual | a verificação de visibilidade do `teamsPlugin` (uma leitura de membership) |
| a rota tem `meta.can` e ao chamador falta uma das suas permissões (RBAC, scope atual; o `superAdmin` passa sempre) | a verificação de visibilidade do `permissionsPlugin` (leituras de grants — nenhum registo `permission:denied`) |
| qualquer chave cujo plugin registe uma verificação em `http:route-visibility` | o `RouteVisibilityCheck` desse plugin |

**Não filtrado** — listado, e recusado na chamada: `mfa`, `scopes`,
`subscribed`/`feature`, audiências, rate limits e tudo o que um handler verifique
por si (ex.: uma policy que corre sobre um recurso carregado com
`authorize(user, permission, resource)` — numa listagem não há recurso), e um
[requisito de recurso do `meta.can`](/pt/guide/authorization#politicas-no-guard-requisitos-de-recurso)
decidido por uma política (o loader nunca corre numa listagem; as permissões
simples ao lado continuam a filtrar). Visibilidade nunca é autorização: o `tools/call` corre sempre todos os
guards, para tools listadas ou não. `listVisibleOnly: false` lista todas as
tools com opt-in. As listagens por stdio nunca são filtradas (não há um chamador
por pedido).

Num deployment exposto, dá ao `/mcp` o seu próprio orçamento de rate limit:
`mcpRoutes({ rateLimit: { limit: 30, windowMs: 60_000 } })` aplica
`meta.rateLimit` à rota, e o `securityPlugin` impõe-no num bucket dedicado.
O `meta.rateLimit` próprio de uma rota-ferramenta é imposto por um guard de
rota, por isso aplica-se também às chamadas de tools através do `/mcp`, com a
chave no ip de quem chama o `/mcp`, que o pedido da tool herda. (Auth e guards
correm de forma idêntica em ambos os caminhos.) Uma chamada de tool sem ip do
chamador — por stdio, ou `MCP.callTool()` sem `ip` — fica com a chave da
identidade do chamador (`ctx().user` / `ctx().tenant`) quando existe; todas as
chamadas anónimas sem ip partilham um único balde `unknown` (falha fechada).
Passa o `ip` (ou resolve-o no adaptador) para ter baldes por cliente.

## Referência de opções

As tabelas abaixo são as opções públicas completas dos quatro pontos de entrada.

### `mcpPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `routes` | `BasaltRoute[]` | — (obrigatório) | As rotas analisadas à procura de `meta.mcp` — tipicamente o mesmo array que passas ao adaptador |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt', version: '0.1.0' }` | O que o `initialize` reporta aos clientes |
| `filter` | `(route: BasaltRoute) => boolean` | expõe todas as rotas com opt-in | Um portão ao nível do deployment por cima do `meta.mcp` (ex.: esconder rotas de admin num ambiente) |
| `forwardHeaders` | `string[]` | nenhum | Headers extra que uma chamada de tool herda, além de `DEFAULT_FORWARDED_HEADERS` (ex.: um header de tenant próprio); todos os outros são descartados |
| `redactErrorDetails` | `ErrorDetailsRedactor \| false` | `redactSensitiveDetails` | Filtra os `details` públicos de um erro lançado antes de entrarem num resultado de tool (ver [O que o modelo vê](#what-the-model-sees-when-a-tool-fails)); `false` envia-os como o HTTP enviaria. Uma rota substitui-o com `meta.mcp.redactErrorDetails` |
| `reportError` | `HttpErrorReporter \| false` | reporter de consola | Recebe cada erro que uma chamada de tool lança, `internalDetails` incluído; `false` não reporta nada |

### `mcpRoutes(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `path` | `string` | `'/mcp'` | Onde o endpoint POST de JSON-RPC é montado |
| `rateLimit` | `{ limit: number; windowMs: number }` | nenhum | Aplica `meta.rateLimit` ao `/mcp` (imposto pelo `securityPlugin` num bucket dedicado) — o orçamento de todo o tráfego de tools; o `meta.rateLimit` próprio de uma rota-ferramenta aplica-se por cima |
| `allowedOrigins` | `string[] \| '*'` | só a mesma origem | Origens de browser autorizadas a chamar o `/mcp`; um `Origin` estranho recebe 403. Pedidos sem `Origin` não são afetados. `'*'` desliga a verificação |
| `auth` | `boolean` | `false` | Aplica `meta.auth` ao `/mcp` (imposto pelo `authPlugin`) para que até `initialize`/`tools/list` exijam um chamador autenticado |
| `meta` | `Record<string, unknown>` | nenhum | `meta` extra para a rota `/mcp` (ex.: `{ can: 'mcp:use' }`) |
| `listVisibleOnly` | `boolean` | `true` | Esconde do `tools/list` as tools que o chamador estaticamente não pode usar — só verificações puras (vê [O que o `tools/list` mostra](#what-tools-list-shows)) |
| `sessions` | `false \| { ttlMs?: number; maxSessions?: number }` | ligado — 30 min inativa, 1000 vivas | Sessões `Mcp-Session-Id`: obrigatórias depois do `initialize`, ligadas ao chamador, dão âmbito ao cancelamento entre `POST`s; monta também `DELETE <path>`. `false` = sem estado |

### `serveMcpStdio(app, options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Headers estáticos aplicados a **todas** as chamadas de tools — o stdio não tem headers por pedido, é assim que um agente local leva um token/tenant de serviço |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Injeta um stream nos testes |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Injeta um sink nos testes |
| `maxConcurrentRequests` | `number` | `16` | Pedidos em curso em simultâneo na ligação; mais um recebe um erro `-32000` (`SERVER_BUSY`). Notificações nunca são recusadas |
| `maxLineLength` | `number` | 4 MiB | A linha de mensagem mais longa aceite |

Devolve um handle cujo `close()` desliga o listener do stdin.

### `mcpClientPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `servers` | `Record<string, { type: 'http'; url; headers? } \| { type: 'stdio'; command; args?; env?; cwd?; inheritEnv? }>` | — (obrigatório) | Servidores externos nomeados registados sob `MCP_CLIENTS`. Um servidor stdio herda só `DEFAULT_INHERITED_ENV` mais `env`; `inheritEnv: string[] \| true` alarga isso |
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
| JSON-RPC `-32602` ``tools/call `arguments` must be an object`` | O cliente enviou `arguments` como array, string, número ou `null` | Envia um objeto de argumentos nomeados conforme o input schema da tool |
| JSON-RPC `-32603` `Internal error` | Algo lançou fora de um resultado de tool (as falhas de tool em si voltam como `isError`) | O texto é genérico de propósito; vê a causa nos logs do servidor |
| JSON-RPC `-32601` `Method not found` | O cliente chamou um método MCP que o servidor não implementa | Só existem `initialize`, `ping`, `tools/list`, `tools/call` (mais resources/prompts quando registados) |
| Uma chamada de tool devolve `RATE_LIMITED` mais cedo do que o esperado | O `meta.rateLimit` próprio da rota-ferramenta aplica-se também através do `/mcp` (por ip do chamador; chamadas anónimas sem ip partilham um balde `unknown`) | Aumenta o orçamento da rota, passa uma `key` ao `securityPlugin({ rateLimit })`, ou garante que o ip / a identidade do chamador são resolvidos |
| `403` `MCP_ORIGIN_FORBIDDEN` do `POST /mcp` | Um browser enviou um pedido de outra origem | Acrescenta a origem da página a `mcpRoutes({ allowedOrigins })` |
| `415` do `POST /mcp` | O corpo não foi enviado como `Content-Type: application/json` | Envia `application/json` (os clientes MCP fazem-no) |
| `400` `Mcp-Session-Id header required` | Chegou uma mensagem que não é `initialize` sem sessão | Envia primeiro `initialize` e repete o seu `Mcp-Session-Id` (os clientes da spec fazem-no), ou `mcpRoutes({ sessions: false })` |
| `404` `Session not found` | A sessão expirou, foi despejada ou terminada, o processo reiniciou, respondeu outra réplica — ou foi apresentada por outro chamador | Volta a inicializar; atrás de réplicas usa sticky sessions |
| Uma tool falta no `tools/list` mas pode ser chamada | O chamador falha estaticamente o seu `meta.auth`/`meta.teamRole`/`meta.can` (a listagem esconde-a) | Esperado; `mcpRoutes({ listVisibleOnly: false })` lista tudo |
| Por stdio, `-32000` `Too many requests in flight` | Mais de `maxConcurrentRequests` chamadas em simultâneo na ligação | Espera pelas respostas, ou aumenta `serveMcpStdio(app, { maxConcurrentRequests })` |
| Uma tool lê um header que chega `undefined` | O header não está na allowlist de headers encaminhados | `mcpPlugin({ forwardHeaders: ['x-my-header'] })` |
| O Claude Desktop mostra um servidor morto/quebrado | Algo imprimiu no stdout — ele é o canal JSON-RPC | `logLevel: 'silent'`, remove `console.log`; vê a checklist de stdio acima |
| `'[REDACTED]'` nos `details` de um erro de tool | A chave nomeia um segredo e o `redactErrorDetails` por omissão mascarou-a | Renomeia a chave se não for um segredo, move segredos para `internalDetails`, ou passa o teu próprio `redactErrorDetails` |
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
