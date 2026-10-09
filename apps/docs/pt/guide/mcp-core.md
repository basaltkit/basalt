# Construir um servidor MCP (`@basaltkit/mcp-core`)

O `@basaltkit/mcp-core` é o fio **sem dependências** por baixo de toda a história
MCP do Basalt: os tipos JSON-RPC 2.0 + [Model Context Protocol](https://modelcontextprotocol.io),
um servidor neutro ao transporte que despacha sobre ferramentas / recursos / prompts
em **forma de função** (com progresso + cancelamento), e os transportes **stdio** e
**HTTP**. Não tem dependências de runtime — nem `@basaltkit/core`, nem
`@basaltkit/http`, nem SDK externo. Usa-o quando queres um servidor MCP cujas
ferramentas são funções simples, sem mais nada no grafo de dependências.

::: tip Que package MCP é que eu quero?
- Expor **as rotas da tua app** a agentes em produção → [`@basaltkit/mcp`](/pt/guide/mcp)
  (as rotas tornam-se ferramentas pelo pipeline neutro; tenancy/auth aplicam-se).
- Expor **fluxos de desenvolvimento** do Basalt ao teu editor → [`@basaltkit/ai-mcp`](/pt/guide/ai-mcp).
- Construir o **teu próprio** servidor MCP a partir de funções arbitrárias, sem o
  runtime do framework no grafo → **este package.**

O `@basaltkit/mcp` e o `@basaltkit/ai-mcp` são ambos construídos sobre o `mcp-core`.
:::

[[toc]]

## Onde encaixa o `mcp-core`

| Camada | Package | Papel | Runtime? |
| --- | --- | --- | --- |
| Inteligência | [`@basaltkit/ai`](/pt/guide/ai) | O CLI `basalt ai`: analyze, doctor, plan, make, review | só dev |
| Ponte de dev | [`@basaltkit/ai-mcp`](/pt/guide/ai-mcp) | Expõe esses fluxos de desenvolvimento ao teu editor por MCP | só dev |
| Fio | **`@basaltkit/mcp-core`** | **Esta página** — protocolo + servidor genérico + transportes | partilhado |
| Superfície de runtime | [`@basaltkit/mcp`](/pt/guide/mcp) | As rotas opt-in da tua app tornam-se ferramentas para agentes | runtime |

O modelo mental é um despachante e dois transportes. O
`McpServer.handleMessage()` transforma uma mensagem JSON-RPC num resultado *sem
saber como ela chegou*; o `serveStdio` e o `serveHttp` são ciclos finos que leem uma
mensagem, chamam o `handleMessage` e escrevem a resposta de volta. Todo o resto — as
tuas ferramentas, recursos e prompts — é um objeto simples com uma função lá dentro.

## Instalação

```bash
pnpm add @basaltkit/mcp-core
```

## Olá, ferramenta (stdio)

Uma ferramenta é um descritor simples com uma função `invoke` — sem rotas, sem
container de DI:

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

// Serve JSON-RPC delimitado por newline no stdin/stdout (o que os agentes locais falam).
serveStdio(server)
```

Aponta qualquer cliente MCP de stdio ao processo e verás o `echo` no `tools/list`.

## O servidor

O `new McpServer({ tools?, resources?, prompts?, serverInfo? })` constrói um
servidor neutro ao transporte. O seu `handleMessage(message, ctx?)` implementa a
superfície JSON-RPC do MCP:

| Método | Comportamento |
| --- | --- |
| `initialize` | Negoceia a versão do protocolo, devolve `{ protocolVersion, capabilities, serverInfo }` |
| `ping` | Devolve `{}` |
| `tools/list` · `tools/call` | Sempre disponíveis |
| `resources/list` · `resources/read` | Só quando há recursos registados — caso contrário `METHOD_NOT_FOUND` |
| `prompts/list` · `prompts/get` | Só quando há prompts registados — caso contrário `METHOD_NOT_FOUND` |
| `notifications/initialized` | Aceite, sem resposta |
| `notifications/cancelled` | Aborta a chamada em curso **da mesma sessão** cujo `params.requestId` corresponda; sem resposta |

Um método de pedido enviado como notificação (sem `id`, ex.: um `tools/call` sem
id) **não é executado nem respondido** — o JSON-RPC nunca responde a uma
notificação. Uma *resposta* JSON-RPC enviada ao servidor é ignorada. Os batches
(arrays) são despachados por `dispatchPayload(server, payload, ctx)`, que todos os
transportes incluídos usam: uma resposta por pedido, `null` para um batch só de
notificações, `-32600` para um batch vazio ou um `initialize` dentro de um batch.

As capacidades são anunciadas **apenas quando existem**: um servidor só com
ferramentas reporta `{ tools: { listChanged: false } }`; regista recursos ou prompts
e a capacidade correspondente aparece. O `serverInfo` predefine para
`{ name: 'basalt-mcp-core', version: '0.1.0' }` — define o teu.

Dois métodos permitem comandar o servidor sem a camada JSON-RPC, que é o que os
testes e quem faz embedding normalmente querem:

```ts
server.listTools()                         // os descritores de ferramenta que o tools/list devolve
await server.callTool('echo', { text: 'hi' })  // lança `Unknown tool: …` para um nome inválido
```

::: warning Os nomes e URIs são chaves, e o último ganha
As ferramentas e os prompts são guardados num `Map` com chave `name`, os recursos
com chave `uri`. Dois descritores com a mesma chave significam que o último
**substitui silenciosamente** o primeiro — não há verificação de duplicados. Gera os
nomes de forma determinística, ou verifica o `server.listTools().length` num teste.
:::

## Ferramentas

```ts
interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema
  outputSchema?: Record<string, unknown> // opcional; anunciado no tools/list
  invoke(args: Record<string, unknown>, ctx: ToolInvokeContext): Promise<McpToolResult>
  visible?(ctx: CallContext): boolean | Promise<boolean> // filtro opcional da listagem
}
```

O `visible` deixa uma tool retirar-se do `tools/list` de um chamador (recebe o
`CallContext` do transporte, incluindo o `caller` opaco). Tem de ser livre de
efeitos secundários — corre em cada listagem — e **não** é autorização: o
`tools/call` nunca o consulta, por isso o `invoke` continua a impor o acesso. Um
hook que lance uma exceção esconde a tool.

Devolve um `McpToolResult`: `{ content: [{ type: 'text', text }], structuredContent?, isError? }`.
Segundo a especificação, o `structuredContent` tem de ser um objeto JSON (um
registo) — arrays e primitivos viajam apenas no texto de `content`.

Há **duas** formas de uma ferramenta falhar, e a diferença importa:

- **Uma falha ao nível da ferramenta** — devolve `{ content: [...], isError: true }`.
  A chamada tem sucesso ao nível do protocolo e o agente lê a tua mensagem. É isto
  que queres para argumentos inválidos, uma operação recusada, uma credencial em
  falta: o modelo consegue ver a razão e tentar outra coisa.
- **Um erro lançado** — torna-se um `INTERNAL_ERROR` JSON-RPC (`-32603`) com a
  mensagem genérica `Internal error`: o texto de uma exceção pode conter segredos,
  caminhos ou SQL, por isso nunca chega ao cliente. O erro original vai para o
  hook `onError(error, message)` do servidor — regista-o aí. Um erro com
  `expose: true` mantém a sua própria mensagem. Reserva o lançar para bugs a sério.

O `arguments` é verificado antes de qualquer ferramenta correr: um `tools/call`
cujo `arguments` existe mas não é um objeto JSON (um array, string, número ou
`null`) é recusado com `INVALID_PARAMS` (`-32602`), tal como um `prompts/get`
cujo `arguments` não é um objeto de valores string. Validar os campos em si
continua a ser trabalho da ferramenta.

### O contexto de invocação — signal, progress, elicit

Cada chamada recebe um `ToolInvokeContext`:

```ts
interface ToolInvokeContext {
  signal: AbortSignal                              // cancelamento pelo cliente
  progress?: (u: { progress?: number; total?: number; message?: string }) => void
  elicit?: (prompt: string) => Promise<boolean>    // pedir confirmação ao cliente
  headers?: Record<string, string | string[] | undefined>  // metadados de transporte por chamada
  remoteAddress?: string                           // o par do transporte, quando conhecido
}
```

O `signal` está sempre presente. O `progress`, o `elicit`, os `headers` e o `remoteAddress` só estão
presentes quando o transporte ou o cliente os forneceram — chama-os sempre de forma
opcional (`ctx.progress?.(…)`), nunca assumas.

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
    // Confirmação: quando não é possível perguntar ao cliente, FALHA FECHADO —
    // nunca trates a ausência de `elicit` como consentimento.
    if (!ctx.elicit || !(await ctx.elicit('Write the output?'))) {
      return { content: [{ type: 'text', text: 'not confirmed' }], isError: true }
    }
    return { content: [{ type: 'text', text: 'done' }] }
  },
}
```

## Progresso & cancelamento

A canalização está ligada ao despachante, por isso não tocas no fio:

- **Progresso** — quando um `tools/call` traz `params._meta.progressToken` **e** o
  transporte forneceu um callback `notify`, o `ctx.progress(...)` emite
  `notifications/progress` com esse token. Se faltar qualquer uma das metades, o
  `ctx.progress` é simplesmente `undefined` — daí a chamada opcional.
- **Cancelamento** — cada `tools/call` em curso com um id não-nulo recebe um
  `AbortController` por pedido, registado sob `(sessão, id)`. Um
  `notifications/cancelled` com o `requestId` correspondente **da mesma sessão**
  aborta o `ctx.signal` — um cliente nunca consegue cancelar a chamada de outro. A
  sessão é o `CallContext.session`: cada stream stdio é a sua própria; em HTTP é
  a sessão `Mcp-Session-Id` quando `serveHttp({ sessions })` está ligado (por isso
  um cancelamento enviado noutro `POST` chega à chamada), senão cada pedido; um
  embedding sem sessão partilha um único âmbito. Um segundo pedido em
  curso que reutilize um id na mesma sessão é recusado (`-32600`). Um `ctx.signal`
  externo passado pelo transporte é ligado ao mesmo controller, por isso um signal
  já abortado aborta a chamada imediatamente (o `serveHttp` aborta quando o cliente
  se desliga).
- **Elicitation** — em stdio, quando o `initialize` do cliente anunciou a
  capacidade `elicitation`, o `ctx.elicit(prompt)` envia um pedido
  `elicitation/create` (um único booleano obrigatório `confirm`) e resolve `true`
  só quando o utilizador aceitou com `confirm: true`. Sem a capacidade, o
  `ctx.elicit` não existe.

As notificações servidor→cliente ao vivo (progresso) exigem um transporte duplex — o
**stdio** entrega-as; o transporte HTTP mínimo é só pedido/resposta.

## Recursos

Contexto read-only que um agente pode puxar, endereçado por URI:

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

O `read(ctx)` recebe um `ResourceReadContext` (`{ signal }`) e pode ser síncrono ou
assíncrono. O `resources/read` devolve `{ contents: [{ uri, mimeType?, text }] }`,
usando o `uri`/`mimeType` do descritor por predefinição. Os recursos **não recebem
argumentos** — se um cliente precisa de parametrizar uma leitura, isso é uma
ferramenta, não um recurso. Um URI desconhecido falha com `INVALID_PARAMS`.

## Prompts

Modelos de mensagens parametrizados (aparecem como slash commands em alguns
clientes):

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

Os `arguments` são apenas anúncio — o despachante passa os `params.arguments` tal e
qual como um `Record<string, string>` sem validar o `required`. Trata tu dos valores
em falta dentro do `get()`.

## Transportes

### stdio

```ts
import { serveStdio } from '@basaltkit/mcp-core'

const handle = serveStdio(server, {
  // headers?: aplicados a todas as chamadas (o stdio não tem headers por pedido)
  // input?: NodeJS.ReadableStream (predefinição process.stdin)
  // output?: { write(chunk: string): unknown } (predefinição process.stdout)
  // maxLineLength?: number (predefinição 4 MiB de caracteres)
  // maxConcurrentRequests?: number (predefinição 16)
})
handle.close() // desliga o listener do stdin
```

JSON-RPC delimitado por newline: uma mensagem por linha, uma resposta por linha
(um array para um batch). As linhas em branco são ignoradas, as notificações não
recebem resposta, e uma linha impossível de interpretar responde com um erro de
parse JSON-RPC (`-32700`, id `null`). O stream de bytes é descodificado com um
`StringDecoder`, por isso um carácter multibyte partido entre chunks sobrevive; uma
linha maior do que `maxLineLength` é descartada sem ser guardada em buffer e
respondida com `-32600`. No máximo `maxConcurrentRequests` pedidos (mensagens com
`id`) correm em simultâneo por ligação; mais um é respondido de imediato com
`-32000` (`RPC_ERRORS.SERVER_BUSY`) — dentro da resposta do batch, num batch —
enquanto as notificações (incluindo `notifications/cancelled`) nunca são contadas
nem recusadas. O transporte fornece também o `notify`, para que as
notificações (progresso) e os pedidos (`elicitation/create`) servidor→cliente saiam
pelo mesmo stream, e as respostas do cliente são encaminhadas de volta.

::: danger O stdout é o protocolo
Em stdio, tudo o que o teu processo imprimir no stdout é interpretado como JSON-RPC.
Um `console.log` perdido corrompe o stream e o cliente vê um servidor morto. Regista
no stderr, ou silencia o logging por completo num ponto de entrada de stdio.
:::

### HTTP (opcional)

```ts
import { serveHttp } from '@basaltkit/mcp-core'

const http = await serveHttp(server, { port: 0, host: '127.0.0.1', path: '/mcp' })
console.log(http.url)   // http://127.0.0.1:<port>/mcp
await http.close()
```

Um servidor `node:http` mínimo — `POST` de JSON-RPC para `path`, um
pedido/resposta por chamada (sem SSE). Usa apenas o `node:http`, por isso um
servidor só-de-dev mantém o runtime do framework fora do seu grafo. Respostas:

| Estado | Quando |
| --- | --- |
| `200` | Uma resposta JSON-RPC normal |
| `202` (corpo vazio) | A mensagem era uma notificação — por especificação não tem resposta |
| `400` | O corpo não era JSON válido (`-32700 Parse error`) — ou, com `sessions` ligado, um pedido que não é `initialize` sem `Mcp-Session-Id` |
| `401` | O `authorize` devolveu `false` |
| `403` | O guard de pedidos rejeitou o `Host`/`Origin` — verificado **antes** do encaminhamento |
| `404` | Método errado ou fora do caminho (`-32601 Not found: <method> <url>`) — ou, com `sessions` ligado, uma sessão desconhecida, expirada ou alheia |
| `204` | Um `DELETE` com um `Mcp-Session-Id` vivo (sessões ligadas) terminou a sessão |
| `413` | O corpo excede `maxBodyBytes` (predefinição 1 MiB) — nunca é guardado em buffer |

Os headers HTTP recebidos são reencaminhados às ferramentas como `ctx.headers` (e o
endereço do par como `ctx.remoteAddress`), por isso uma ferramenta pode ler metadados por chamada (um id de tenant, um bearer
token) da mesma forma que leria os `headers` estáticos do stdio. Um header enviado uma
vez é uma string; um header enviado mais de uma vez é um `string[]` com todos os valores
(o `req.headers` do Node juntá-los-ia com `, `, ou guardaria só o primeiro
`authorization`) — por isso uma ferramenta pode recusar um duplicado ambíguo com
`Array.isArray(ctx.headers[name])`. Um `host` IPv6 funciona com ou sem parênteses rectos
(`'::1'`, `handle.url` → `http://[::1]:port/mcp`), e o `serveHttp` rejeita com o erro do
`listen()` (`EADDRINUSE`) quando o endereço não pode ser ligado.

#### Sessões (opt-in) {#http-sessions}

`serveHttp(server, { sessions: true })` (ou `{ ttlMs, maxSessions }`) liga as
sessões Streamable-HTTP: um `initialize` bem-sucedido responde com um header
`Mcp-Session-Id`, todos os pedidos seguintes têm de o levar, e um `DELETE` com
ele termina a sessão. Todos os pedidos de uma sessão partilham um âmbito de
cancelamento, por isso um `notifications/cancelled` enviado por `POST` enquanto
uma chamada corre cancela-a — uma sessão diferente, mesmo que adivinhe o id do
pedido, nunca consegue. Cada sessão fica ligada a um principal — `principal(req)`
se o passares, senão um hash do header `Authorization` — e um pedido que
apresente outro principal é tratado como uma sessão desconhecida (404). As
sessões expiram após `ttlMs` inativas (predefinição 30 min) e há no máximo
`maxSessions` vivas (predefinição 1000; a usada há mais tempo é despejada). A
tabela é exportada como `McpSessions` para outros transportes (a rota `/mcp` de
runtime do `@basaltkit/mcp` usa-a). A predefinição continua sem estado (cada
pedido a sua própria sessão) para que os clientes sem header de uma ponte de dev
existente continuem a funcionar.

::: warning O transporte HTTP é guardado ao loopback por predefinição
Liga-se a `127.0.0.1` e, antes de qualquer despacho, exige que o hostname do `Host`
seja um nome de loopback (anti-DNS-rebinding) e — *quando existe um header
`Origin`* — que essa origem seja de loopback (anti-CSRF; os browsers enviam sempre
`Origin` num POST cross-site, por isso a sua ausência significa um cliente
não-browser e é permitida). Alarga-o deliberadamente com `allowedHosts` /
`allowedOrigins`, ou substitui a verificação toda com `allowRequest`.

Esse guard trava **browsers**; **não é autenticação** — o header `Host` é o que o
cliente quiser enviar, e qualquer cliente que não seja um browser pode enviar
`Host: 127.0.0.1`. Por isso, ligar a um `host` fora do loopback (ex.: `0.0.0.0`) é
**recusado**, a não ser que passes também `authorize` (ex.: uma verificação de
bearer token) ou `allowRequest`. Este transporte é uma superfície de dev/CI, não um
endpoint público.
:::

## Detalhes do protocolo

```ts
import {
  SUPPORTED_PROTOCOL_VERSIONS, // ['2025-06-18', '2025-03-26', '2024-11-05']
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,                  // PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, …
  negotiateVersion,            // honra a versão do cliente se for suportada, senão a mais recente
  ok, fail, isNotification,    // construtores de resposta + a regra "sem id ⇒ sem resposta"
} from '@basaltkit/mcp-core'
```

O `initialize` negoceia a versão do protocolo (`negotiateVersion`) e devolve as
capacidades do servidor + o `serverInfo`. O Basalt fala MCP diretamente — não há
dependência de SDK, e o mesmo `handleMessage` comanda todos os transportes.

| Constante | Valor |
| --- | --- |
| `RPC_ERRORS.PARSE_ERROR` | `-32700` |
| `RPC_ERRORS.INVALID_REQUEST` | `-32600` |
| `RPC_ERRORS.METHOD_NOT_FOUND` | `-32601` |
| `RPC_ERRORS.INVALID_PARAMS` | `-32602` |
| `RPC_ERRORS.INTERNAL_ERROR` | `-32603` |

## Contraste: `mcp-core` vs `@basaltkit/mcp` de runtime

| | `@basaltkit/mcp-core` | [`@basaltkit/mcp`](/pt/guide/mcp) |
| --- | --- | --- |
| As ferramentas são… | **funções** arbitrárias (`McpToolDef`) | **rotas** opt-in (`meta.mcp`) |
| Dependências | **zero** | `@basaltkit/core` + `@basaltkit/http` |
| Corre por | o teu `invoke` | o pipeline neutro de pedidos (tenancy/auth) |
| Usa quando | constróis um servidor MCP autónomo/de dev | expões a API de uma app a agentes |

Usa o `mcp-core` quando queres um servidor MCP pequeno e sem framework (uma
ferramenta de dev, um companheiro de CLI, uma superfície de agente à medida). Usa o
`@basaltkit/mcp` quando as ferramentas *são* os endpoints da tua app e devem honrar
a mesma validação, tenancy e auth que o HTTP.

## Referência de opções

### `new McpServer(options)`

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `tools` | `McpToolDef[]` | `[]` | A superfície chamável. Uma lista vazia continua a anunciar a capacidade `tools` |
| `resources` | `McpResourceDef[]` | `[]` | Contexto read-only. Registar algum ativa o `resources/list` + `resources/read` |
| `prompts` | `McpPromptDef[]` | `[]` | Modelos de mensagens. Registar algum ativa o `prompts/list` + `prompts/get` |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt-mcp-core', version: '0.1.0' }` | O que o `initialize` reporta — os clientes mostram isto, por isso define-o |
| `onError` | `(error: unknown, message: JsonRpcRequest) => void` | nenhum | Recebe o erro original quando uma ferramenta, recurso ou prompt lança (o cliente só vê `Internal error`). Regista-o aqui; um hook que lança é ignorado |

### `McpToolDef`

| Campo | Tipo | Obrigatório | Objetivo |
| --- | --- | --- | --- |
| `name` | `string` | sim | A chave do `tools/call`. Duplicados sobrescrevem silenciosamente |
| `description` | `string` | sim | Como o modelo decide chamá-la — a string com mais alavancagem no ficheiro |
| `inputSchema` | `Record<string, unknown>` | sim | JSON Schema dos argumentos; não é imposto pelo despachante, valida dentro do `invoke` |
| `outputSchema` | `Record<string, unknown>` | não | Anunciado no `tools/list` para o cliente poder tipar o resultado |
| `visible` | `(ctx: CallContext) => boolean \| Promise<boolean>` | não | Filtro de listagem sem efeitos secundários: `false` deixa a tool fora do `tools/list` deste chamador. Nunca consultado pelo `tools/call` |
| `invoke` | `(args, ctx) => Promise<McpToolResult>` | sim | O trabalho. Devolve `isError: true` para falhas esperadas; lança só para bugs |

### `McpResourceDef` / `McpPromptDef`

| Campo | Tipo | Obrigatório | Objetivo |
| --- | --- | --- | --- |
| `McpResourceDef.uri` | `string` | sim | A chave do `resources/read` e o `contents[0].uri` predefinido |
| `McpResourceDef.name` · `description` | `string` | só o name | Metadados de listagem |
| `McpResourceDef.mimeType` | `string` | não | MIME predefinido para leituras que não definam o seu |
| `McpResourceDef.read` | `(ctx: { signal }) => McpResourceContents \| Promise<…>` | sim | Devolve `{ uri?, mimeType?, text }`; síncrono ou assíncrono |
| `McpPromptDef.name` · `description` | `string` | só o name | A chave do `prompts/get` e metadados de listagem |
| `McpPromptDef.arguments` | `McpPromptArgument[]` | não | Apenas anúncio — o `required` **não** é imposto |
| `McpPromptDef.get` | `(args: Record<string, string>) => McpPromptResult \| Promise<…>` | sim | Devolve `{ description?, messages }` |

### `serveStdio(server, options)`

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Metadados estáticos por chamada — o stdio não tem headers por pedido, por isso é assim que um cliente local transporta um token ou tenant |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Injeta um stream em testes |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Injeta um destino em testes |
| `maxLineLength` | `number` | `4194304` (4 MiB de caracteres) | Uma linha maior é descartada (respondida com `-32600`) em vez de fazer crescer o buffer |
| `maxConcurrentRequests` | `number` | `16` (`DEFAULT_MAX_CONCURRENT_REQUESTS`) | Pedidos em curso em simultâneo por ligação; mais um recebe `-32000` (`SERVER_BUSY`). As notificações nunca são recusadas |

Devolve um `StdioHandle`; o `close()` desliga o listener de `data` (não termina o
stream).

### `serveHttp(server, options)`

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `port` | `number` | `0` | `0` escolhe uma porta efémera — lê-a de volta no handle |
| `host` | `string` | `'127.0.0.1'` | Endereço de bind. Loopback por predefinição porque isto é uma superfície de dev |
| `path` | `string` | `'/mcp'` | O endpoint JSON-RPC. Qualquer outra coisa responde `404` |
| `allowedHosts` | `string[]` | só nomes de loopback | Hostnames `Host` extra a aceitar quando ligas deliberadamente fora do loopback. Sem distinguir maiúsculas, porta ignorada |
| `allowedOrigins` | `string[]` | só origens de loopback | Valores `Origin` extra (esquema + host + porta completos) |
| `allowRequest` | `(origin: string \| undefined, host: string \| undefined, req: IncomingMessage) => boolean` | — | Substituição total — **substitui** as verificações de loopback/`allowedHosts`/`allowedOrigins`. Devolver `true` sempre desativa o guard |
| `authorize` | `(req: IncomingMessage) => boolean \| Promise<boolean>` | — | Autentica um pedido que passou o guard; `false` responde `401`. Obrigatório (ou `allowRequest`) para ligar a um `host` fora do loopback |
| `maxBodyBytes` | `number` | `1048576` (1 MiB) | Corpos maiores recebem `413` e não são guardados em buffer |
| `sessions` | `boolean \| { ttlMs?: number; maxSessions?: number }` | `false` (sem estado) | Sessões `Mcp-Session-Id` — vê [Sessões](#http-sessions) |
| `principal` | `(req: IncomingMessage) => string \| undefined \| Promise<…>` | hash do `Authorization` | A quem uma sessão fica ligada |

Devolve `Promise<HttpHandle>` — `{ port, url, close() }`.

### `CallContext` — o que um transporte fornece

Só constróis isto tu quando embutes o `handleMessage` no teu próprio transporte.

| Campo | Tipo | Fornecido por | Objetivo |
| --- | --- | --- | --- |
| `headers` | `Record<string, string \| string[] \| undefined>` | stdio (`options.headers`), HTTP (headers do pedido) | Reencaminhado tal e qual para o `ctx.headers` nas ferramentas |
| `progress` | `(u: ProgressUpdate) => void` | tu | Um destino de progresso explícito; tem precedência sobre o par `progressToken` + `notify` |
| `elicit` | `(prompt: string) => Promise<boolean>` | stdio (quando o cliente anunciou `elicitation`), ou tu | Pedir confirmação ao cliente; aparece como `ctx.elicit` |
| `notify` | `(message: JsonRpcRequest) => void` | stdio | Empurra notificações servidor→cliente. Sem ele, o progresso por `progressToken` é descartado |
| `signal` | `AbortSignal` | HTTP (cliente desligou-se), ou tu | Um abort externo ligado ao controller por pedido |
| `session` | `unknown` (comparado por identidade) | stdio (um por stream), HTTP (a sessão `Mcp-Session-Id`, ou um por pedido sem estado) | Delimita os ids em curso: o `notifications/cancelled` só chega a chamadas da mesma sessão. Omitido ⇒ um único âmbito partilhado |
| `caller` | `unknown` | tu / a rota `/mcp` de runtime (o contexto do pedido) | Entregue aos hooks `visible` das tools; o core nunca o lê |
| `remoteAddress` | `string` | HTTP (endereço do socket) | Reencaminhado para `ctx.remoteAddress` |

## Modos de falha & resolução de problemas

| Mensagem | Código | Onde | Quando |
| --- | --- | --- | --- |
| `Parse error` | `-32700` | linha de stdio, corpo HTTP | A mensagem não era JSON válido. O HTTP responde `400`; o stdio responde com id `null` |
| `Invalid JSON-RPC request` | `-32600` | `handleMessage` | `jsonrpc !== '2.0'` ou o `method` não é uma string |
| `Forbidden: host/origin not allowed` | `-32600` (HTTP `403`) | guard do `serveHttp` | `Host` ou `Origin` estranho; rejeitado antes de qualquer despacho |
| `Unauthorized` | `-32600` (HTTP `401`) | `authorize` do `serveHttp` | O `authorize` devolveu `false` (ou lançou) |
| `Request body exceeds <n> bytes` | `-32600` (HTTP `413`) | `serveHttp` | Corpo acima de `maxBodyBytes` |
| `Message exceeds the maximum line length (<n>)` | `-32600` | stdio | Linha acima de `maxLineLength`; a linha é descartada |
| `Request id <id> is already in flight` | `-32600` | `dispatchToolCall` | A mesma sessão reutilizou um id ainda em curso |
| `Too many requests in flight (max <n>); retry later` | `-32000` | stdio | Mais de `maxConcurrentRequests` pedidos a correr na ligação |
| `Bad Request: Mcp-Session-Id header required …` | `-32600` (HTTP `400`) | `serveHttp` (sessões ligadas) | Um pedido que não é `initialize` sem o header |
| `Session not found …` | `-32600` (HTTP `404`) | `serveHttp` (sessões ligadas) | Sessão desconhecida, expirada, despejada ou alheia — volta a inicializar |
| `serveHttp: refusing to bind non-loopback host …` | (promise rejeitada) | `serveHttp` | `host` fora do loopback sem `authorize`/`allowRequest` |
| `Method not found: <method>` | `-32601` | `handleMessage` | Um método desconhecido — **ou** `resources/*` / `prompts/*` num servidor que não registou nenhum |
| `Not found: <method> <url>` | `-32601` (HTTP `404`) | `serveHttp` | Não-`POST`, ou um caminho diferente do `options.path` |
| ``tools/call requires a string `name` `` | `-32602` | `dispatchToolCall` | O `params.name` está em falta ou não é uma string |
| `Unknown tool: <name>` | `-32602` (ou um `Error` lançado pelo `callTool`) | despachante / `callTool` | Não há ferramenta registada com esse nome |
| ``resources/read requires a string `uri` `` · `Unknown resource: <uri>` | `-32602` | `dispatchResourceRead` | URI de recurso em falta/desconhecido |
| ``prompts/get requires a string `name` `` · `Unknown prompt: <name>` | `-32602` | `dispatchPromptGet` | Nome de prompt em falta/desconhecido |
| ``tools/call `arguments` must be an object `` | `-32602` | `dispatchToolCall` | O `params.arguments` é um array, string, número ou `null`; a ferramenta nunca corre |
| ``prompts/get `arguments` must be an object of string values `` | `-32602` | `dispatchPromptGet` | O `params.arguments` não é um objeto, ou um dos seus valores não é string |
| `Internal error` | `-32603` | catch do `handleMessage` | Uma ferramenta, recurso ou prompt **lançou**. O erro real vai para o `onError`; define `expose: true` num erro para enviar a sua própria mensagem. Prefere `isError: true` para falhas esperadas |

- **O cliente mostra o servidor como morto, logo de imediato** — em stdio, algo
  escreveu no stdout que não era JSON-RPC. Encaminha todo o logging para o stderr.
- **O `ctx.progress` está undefined na minha ferramenta** — o progresso precisa
  *tanto* de um `_meta.progressToken` do cliente *como* de um `notify` do
  transporte. Em HTTP não há `notify`, por isso o progresso nunca é entregue; usa
  stdio, ou passa um `progress` explícito num `CallContext` quando fizeres embedding.
- **O cancelamento não faz nada** — o `notifications/cancelled` só aborta chamadas
  registadas sob um id de pedido não-nulo **na mesma sessão** (em HTTP, liga
  `serveHttp({ sessions: true })` e envia o cancelamento com o mesmo
  `Mcp-Session-Id`; sem estado, cada pedido é a sua própria sessão — desliga a
  ligação em vez disso), e o teu `invoke` tem mesmo
  de observar o `ctx.signal`. Um ciclo síncrono apertado nunca vai reparar nele.
- **O meu `tools/call` sem `id` nunca corre** — por desenho: um método de pedido
  enviado como notificação não é executado (o resultado nunca poderia ser entregue).
- **O `resources/list` devolve `-32601` apesar de eu ter registado um recurso** — o
  método é ativado pelos recursos passados ao **construtor**; não há um `register()`
  pós-construção. Constrói o servidor com a lista completa.
- **O `structuredContent` é ignorado pelo meu cliente** — o MCP exige que seja um
  objeto JSON. Arrays e primitivos têm de viajar em `content` como texto.
- **Duas ferramentas, só uma aparece** — `name`s duplicados sobrescrevem-se no `Map`.

## Ver também

- [`@basaltkit/ai-mcp`](/pt/guide/ai-mcp) — a ponte de dev construída sobre este pacote.
- [MCP (runtime)](/pt/guide/mcp) — rotas como ferramentas, em produção.
- [Desenvolvimento assistido por IA](/pt/guide/ai) — os fluxos que a ponte de dev expõe.
- Fonte: `packages/mcp-core/src/**` (`protocol.ts`, `server.ts`, `stdio.ts`, `http.ts`).
