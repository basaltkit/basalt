# Construir um servidor MCP (`@basaltkit/mcp-core`)

O `@basaltkit/mcp-core` é o protocolo **sem dependências** por baixo de toda a
história MCP do Basalt: os tipos JSON-RPC 2.0 + [Model Context Protocol](https://modelcontextprotocol.io),
um servidor independente de transporte que despacha sobre ferramentas / recursos /
prompts em forma de **função** (com progresso + cancelamento), e transportes
**stdio** e **HTTP**. Não tem dependências de runtime — sem `@basaltkit/core`, sem
`@basaltkit/http`, sem SDK externo.

::: tip Qual pacote MCP quero?
- Expor **as rotas da tua app** a agentes em produção → [`@basaltkit/mcp`](./mcp)
  (as rotas tornam-se ferramentas pela pipeline neutra; tenancy/auth aplicam-se).
- Expor **fluxos de desenvolvimento** do Basalt ao teu editor → [`@basaltkit/ai-mcp`](./ai-mcp).
- Construir o **teu próprio** servidor MCP a partir de funções arbitrárias, sem
  runtime da framework no grafo → **este pacote.**

O `@basaltkit/mcp` e o `@basaltkit/ai-mcp` são ambos construídos sobre o `mcp-core`.
:::

[[toc]]

## Instalação

```bash
pnpm add @basaltkit/mcp-core
```

## Olá, ferramenta (stdio)

Uma ferramenta é um simples descritor com uma função `invoke` — sem rotas, sem
container de DI:

```ts
import { McpServer, serveStdio, type McpToolDef } from '@basaltkit/mcp-core'

const echo: McpToolDef = {
  name: 'echo',
  description: 'Devolve a entrada',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async invoke(args) {
    return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
  },
}

const server = new McpServer({
  tools: [echo],
  serverInfo: { name: 'demo', version: '1.0.0' },
})

// Serve JSON-RPC delimitado por linhas em stdin/stdout (o que os agentes locais falam).
serveStdio(server)
```

Aponta qualquer cliente MCP por stdio ao processo e verás o `echo` em `tools/list`.

## O servidor

`new McpServer({ tools?, resources?, prompts?, serverInfo? })` constrói um servidor
independente de transporte. O seu `handleMessage(message, ctx?)` implementa a
superfície JSON-RPC do MCP: `initialize`, `ping`, `tools/list`, `tools/call` e —
quando os registas — `resources/list`, `resources/read`, `prompts/list`,
`prompts/get`.

As capacidades são anunciadas **apenas quando presentes**: um servidor só com
ferramentas reporta `{ tools: { listChanged: false } }`; regista recursos ou
prompts e a capacidade correspondente aparece. Métodos desconhecidos devolvem
`METHOD_NOT_FOUND`; pedidos malformados `INVALID_REQUEST`; um erro lançado pela
ferramenta surge como `INTERNAL_ERROR` (enquanto uma falha *ao nível da ferramenta*
viaja no resultado como `isError`, não como erro de protocolo).

## Ferramentas

```ts
interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema
  outputSchema?: Record<string, unknown> // opcional; anunciado em tools/list
  invoke(args: Record<string, unknown>, ctx: ToolInvokeContext): Promise<McpToolResult>
}
```

Devolve um `McpToolResult`: `{ content: [{ type: 'text', text }], structuredContent?, isError? }`.
Segundo a especificação, `structuredContent` tem de ser um objeto JSON (um record)
— arrays e primitivos viajam apenas no texto de `content`.

### O contexto de invocação — signal, progress, elicit

Cada chamada recebe um `ToolInvokeContext`:

```ts
interface ToolInvokeContext {
  signal: AbortSignal                              // cancelamento do cliente
  progress?: (u: { progress?: number; total?: number; message?: string }) => void
  elicit?: (prompt: string) => Promise<boolean>    // pedir confirmação ao cliente
  headers?: Record<string, string | string[] | undefined>  // metadados por chamada do transporte
}
```

```ts
const build: McpToolDef = {
  name: 'build',
  description: 'Um trabalho longo que reporta progresso e respeita cancelamento',
  inputSchema: { type: 'object' },
  async invoke(_args, ctx) {
    for (let i = 0; i < 3; i++) {
      if (ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      ctx.progress?.({ progress: i + 1, total: 3, message: `passo ${i + 1}` })
      await step(i)
    }
    // Confirmação interativa opcional, quando o cliente suporta elicitation:
    if (ctx.elicit && !(await ctx.elicit('Escrever o resultado?'))) {
      return { content: [{ type: 'text', text: 'ignorado' }], isError: true }
    }
    return { content: [{ type: 'text', text: 'concluído' }] }
  },
}
```

## Progresso & cancelamento

A canalização está integrada no despachante, por isso não tocas no protocolo:

- **Progresso** — quando um `tools/call` traz `params._meta.progressToken` e o
  transporte consegue enviar notificações, o `ctx.progress(...)` emite
  `notifications/progress` com esse token.
- **Cancelamento** — cada chamada em curso recebe um `AbortController` por pedido.
  Um `notifications/cancelled` com o `requestId` correspondente aborta o
  `ctx.signal`.

As notificações servidor→cliente ao vivo (progresso) requerem um transporte duplex
— o **stdio** entrega-as; o transporte HTTP mínimo é apenas pedido/resposta.

## Recursos

Contexto só-de-leitura que um agente pode puxar, endereçado por URI:

```ts
import type { McpResourceDef } from '@basaltkit/mcp-core'

const context: McpResourceDef = {
  uri: 'demo://project/context',
  name: 'Contexto do projeto',
  description: 'O estado atual do projeto',
  mimeType: 'application/json',
  read() {
    return { text: JSON.stringify({ ok: true }) } // { uri?, mimeType?, text }
  },
}

new McpServer({ resources: [context] })
```

O `resources/read` devolve `{ contents: [{ uri, mimeType?, text }] }`, herdando o
`uri`/`mimeType` do descritor. Um URI desconhecido falha com `INVALID_PARAMS`.

## Prompts

Modelos de mensagens parametrizados (aparecem como slash commands em alguns
clientes):

```ts
import type { McpPromptDef } from '@basaltkit/mcp-core'

const greet: McpPromptDef = {
  name: 'greet',
  description: 'Um modelo de saudação',
  arguments: [{ name: 'who', description: 'Nome a saudar', required: true }],
  get(args) {
    return {
      description: `Saudar ${args['who']}`,
      messages: [{ role: 'user', content: { type: 'text', text: `Olá ${args['who']}` } }],
    }
  },
}

new McpServer({ prompts: [greet] })
```

## Transportes

### stdio

```ts
import { serveStdio } from '@basaltkit/mcp-core'

const handle = serveStdio(server, {
  // headers?: aplicados a cada chamada (stdio não tem cabeçalhos por pedido)
  // input?: NodeJS.ReadableStream (predefinição process.stdin)
  // output?: { write(chunk: string): unknown } (predefinição process.stdout)
})
handle.close() // remove o listener do stdin
```

JSON-RPC delimitado por linhas. Suporta notificações servidor→cliente (progresso),
as notificações não recebem resposta e um erro de parsing devolve um erro de
parsing JSON-RPC.

### HTTP (opcional)

```ts
import { serveHttp } from '@basaltkit/mcp-core'

const http = await serveHttp(server, { port: 0, host: '127.0.0.1', path: '/mcp' })
console.log(http.url)   // http://127.0.0.1:<port>/mcp
await http.close()
```

Um servidor `node:http` mínimo — `POST` JSON-RPC para `path`, um pedido/resposta
por chamada (sem SSE), `202` para notificações, `400`/`404` para corpo inválido /
fora do caminho. Usa apenas `node:http`, por isso um servidor só-de-dev mantém o
runtime da framework fora do seu grafo.

## Detalhes do protocolo

```ts
import {
  SUPPORTED_PROTOCOL_VERSIONS, // ['2025-06-18', '2025-03-26', '2024-11-05']
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,                  // PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, …
  negotiateVersion,            // respeita a versão do cliente se suportada, senão a mais recente
} from '@basaltkit/mcp-core'
```

O `initialize` negoceia a versão do protocolo (`negotiateVersion`) e devolve as
capacidades do servidor + `serverInfo`. O Basalt fala MCP diretamente — não há
dependência de SDK, e o mesmo `handleMessage` comanda todos os transportes.

## Contraste: `mcp-core` vs `@basaltkit/mcp` de runtime

| | `@basaltkit/mcp-core` | [`@basaltkit/mcp`](./mcp) |
| --- | --- | --- |
| As ferramentas são… | **funções** arbitrárias (`McpToolDef`) | **rotas** opt-in (`meta.mcp`) |
| Dependências | **zero** | `@basaltkit/core` + `@basaltkit/http` |
| Corre através de | o teu `invoke` | a pipeline neutra de pedidos (tenancy/auth) |
| Usa quando | constróis um servidor MCP autónomo/de dev | expões a API de uma app a agentes |

Escolhe o `mcp-core` quando queres um servidor MCP pequeno e sem framework (uma
ferramenta de dev, um companheiro de CLI, uma superfície de agente à medida).
Escolhe o `@basaltkit/mcp` quando as ferramentas *são* os endpoints da tua app e
devem respeitar a mesma validação, tenancy e auth do HTTP.

## Ver também

- [`@basaltkit/ai-mcp`](./ai-mcp) — a ponte de dev construída sobre este pacote.
- [MCP (runtime)](./mcp) — rotas como ferramentas, em produção.
- Fonte: `packages/mcp-core/src/**` (`protocol.ts`, `server.ts`, `stdio.ts`, `http.ts`).
