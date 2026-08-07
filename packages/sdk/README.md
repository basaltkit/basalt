# @machize/sdk

Cliente HTTP com tipos seguros para APIs Machize: descreves os endpoints uma vez com Zod e obténs um cliente onde cada chamada tem os tipos certos de entrada e saída, erros estruturados e renovação automática do token de sessão. Precisas dele no frontend (React, Vue, etc.) ou em qualquer código que chame a tua API.

## O que este módulo resolve

Um **SDK** (Software Development Kit) é, aqui, uma biblioteca-cliente: em vez de escreveres `fetch('https://api...')` à mão em todo o lado — montando URLs, cabeçalhos e `JSON.stringify` — chamas funções com nomes claros, como `api.projects.create({ body: { name: 'X' } })`.

O problema clássico dos clientes escritos à mão é o **desalinhamento entre cliente e servidor**: o backend muda um campo, o frontend continua a assumir o formato antigo, e o erro só aparece em produção. Este pacote resolve isso com uma única fonte de verdade: cada endpoint é descrito com `endpoint(...)` usando **schemas Zod** (Zod é uma biblioteca de validação que também gera tipos TypeScript). O TypeScript infere daí os tipos de entrada e saída — não escreves tipos à mão — e, em tempo de execução, a resposta do servidor é validada contra o schema: se não corresponder, recebes um erro claro (`CLIENT_RESPONSE_MISMATCH`) em vez de dados silenciosamente errados.

O cliente trata ainda da autenticação por token **Bearer** (o token vai no cabeçalho `Authorization`), incluindo o padrão de renovação: quando o servidor responde 401 (token expirado), chama a tua função `refresh` uma vez e repete o pedido com o token novo — de forma transparente para quem chamou. O pacote é amigo do browser: a única dependência é o Zod (nem sequer depende de `@machize/core`).

## Instalação

```bash
pnpm add @machize/sdk zod
```

> O Zod é uma *peer dependency* (aceita `^3.24.0` ou `^4.0.0`) — tens de o instalar tu. O cliente usa o `fetch` global (browsers e Node 18+); noutros ambientes passa a tua implementação em `options.fetch`.

## Começar em 5 minutos

1. Descreve a API num ficheiro partilhável, por exemplo `src/api.ts`:

```typescript
import { z } from 'zod'
import { endpoint } from '@machize/sdk'

const Project = z.object({ id: z.string(), name: z.string() })

export const api = {
  projects: {
    list: endpoint({ method: 'GET', path: '/projects', result: z.array(Project) }),
    get: endpoint({
      method: 'GET',
      path: '/projects/:id',
      params: z.object({ id: z.string() }),
      result: Project,
    }),
    create: endpoint({
      method: 'POST',
      path: '/projects',
      body: z.object({ name: z.string() }),
      result: Project,
    }),
  },
}
```

2. Cria o cliente e usa-o:

```typescript
import { createClient } from '@machize/sdk'
import { api } from './api.js'

const client = createClient(api, { baseUrl: 'https://api.example.com' })

const novo = await client.projects.create({ body: { name: 'Machize' } })
console.log(novo.id) // tipado: { id: string; name: string }

const um = await client.projects.get({ params: { id: novo.id } })
const todos = await client.projects.list()
```

3. Repara: o cliente espelha a forma do objeto `api` (`client.projects.create`, …), os argumentos são verificados pelo TypeScript e a resposta vem já validada.

## Guia de utilização

### Corpo, parâmetros de caminho e query string

Cada chamada aceita um objeto com até três partes, conforme o endpoint declarar:

- `body` — o corpo JSON do pedido (schema `body`);
- `params` — valores para os marcadores `:nome` no caminho (schema `params`); são codificados com `encodeURIComponent`;
- `query` — pares para a query string `?a=1&b=2` (schema `query`); `undefined`/`null` são omitidos e arrays repetem a chave.

```typescript
import { z } from 'zod'
import { createClient, endpoint } from '@machize/sdk'

const api = {
  search: endpoint({
    method: 'GET',
    path: '/projects',
    query: z.object({ limit: z.number().optional(), tag: z.array(z.string()).optional() }),
    result: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
}

const client = createClient(api, { baseUrl: 'https://api.example.com' })
await client.search({ query: { limit: 10, tag: ['a', 'b'] } })
// → GET /projects?limit=10&tag=a&tag=b
```

Endpoints sem `body`, `query` nem `params` chamam-se sem argumento: `await client.ping()`.

### Autenticação com token e renovação automática

```typescript
import { createClient } from '@machize/sdk'
import { api } from './api.js'

let accessToken: string | undefined
let refreshToken: string | undefined

const client = createClient(api, {
  baseUrl: 'https://api.example.com',
  getToken: () => accessToken, // vai em Authorization: Bearer <token>
  refresh: async () => {
    // chamado UMA vez quando um pedido leva 401; devolve o token novo,
    // ou null para desistir (o 401 é então lançado a quem chamou)
    if (!refreshToken) return null
    const response = await fetch('https://api.example.com/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) return null
    const tokens = await response.json()
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
    return tokens.accessToken
  },
})
```

Fluxo: pedido → 401 → `refresh()` → repete o pedido com o token novo. Se a repetição voltar a dar 401, o erro é lançado (não há ciclo infinito).

### Tratar erros

Qualquer resposta não-2xx (e qualquer resposta que falhe o schema `result`) lança `MachizeClientError`:

```typescript
import { MachizeClientError } from '@machize/sdk'

try {
  await client.projects.get({ params: { id: 'fantasma' } })
} catch (error) {
  if (error instanceof MachizeClientError) {
    console.log(error.status)  // 404
    console.log(error.code)    // 'PROJECT_NOT_FOUND' (código estável do servidor)
    console.log(error.message) // 'Project not found'
    console.log(error.details) // corpo completo da resposta
  }
}
```

O `code` vem de `body.error.code` (a convenção de erros das APIs Machize); sem ele, é `'HTTP_ERROR'`. Respostas 204 (sem conteúdo) resolvem para `undefined`.

### Testar com um `fetch` falso

Não precisas de servidor — injeta um `fetch` de mentira (exemplo real da suite de testes):

```typescript
import { expect, it } from 'vitest'
import { createClient } from '@machize/sdk'
import { api } from './api.js'

it('cria um projeto', async () => {
  const fetchMock: typeof fetch = async () =>
    new Response(JSON.stringify({ id: 'p1', name: 'Machize' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })

  const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })
  const project = await client.projects.create({ body: { name: 'Machize' } })
  expect(project).toEqual({ id: 'p1', name: 'Machize' })
})
```

## Referência da API

Exportado a partir de `@machize/sdk`:

### `endpoint(spec): Endpoint`

Descreve um endpoint. Devolve o objeto tal e qual, com os tipos genéricos capturados para a inferência.

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | Sim | — | Verbo HTTP |
| `path` | `string` | Sim | — | Caminho com marcadores `:param`, ex.: `/projects/:id` |
| `body` | `ZodType` | Não | — | Schema do corpo do pedido |
| `query` | `ZodType` | Não | — | Schema da query string |
| `params` | `ZodType` | Não | — | Schema dos parâmetros de caminho |
| `result` | `ZodType` | Não | — | Schema da resposta de sucesso — validado no cliente para apanhar desalinhamentos |

### `createClient(endpoints, options): Client<T>`

Constrói o cliente a partir de uma árvore de endpoints (objetos aninhados a qualquer profundidade). Cada folha `Endpoint` torna-se uma função `async`; cada ramo torna-se um objeto. Lança `Error` se não houver `fetch` disponível e não passares um.

`ClientOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `baseUrl` | `string` | Sim | — | Raiz da API, ex.: `'https://api.example.com'` (barra final é tolerada) |
| `fetch` | `typeof fetch` | Não | `globalThis.fetch` | Implementação de fetch |
| `headers` | `Record<string, string>` | Não | — | Cabeçalhos enviados em todos os pedidos (antes da autenticação) |
| `getToken` | `() => string \| undefined \| Promise<string \| undefined>` | Não | — | Token atual — anexado como `Authorization: Bearer` |
| `refresh` | `() => Promise<string \| null>` | Não | — | Chamado uma vez num 401 para obter token novo; `null` desiste e o 401 é lançado |

### `MachizeClientError`

Erro lançado para qualquer resposta não-2xx ou resposta que falhe o schema `result`. Sem dependências (não estende `MachizeError`) para se manter leve no browser.

| Propriedade | Tipo | Descrição |
| --- | --- | --- |
| `status` | `number` | Código HTTP da resposta |
| `code` | `string` | Código estável do servidor (`body.error.code`), `'HTTP_ERROR'` se ausente, ou `'CLIENT_RESPONSE_MISMATCH'` quando a resposta falha o schema `result` |
| `message` | `string` | Mensagem do servidor (ou `statusText`) |
| `details` | `unknown` | Corpo da resposta (ou o `ZodError`, no caso de mismatch) |

### Tipos utilitários

| Tipo | Descrição |
| --- | --- |
| `Endpoint<B, Q, P, R>` | A forma de um endpoint (genéricos: body, query, params, result) |
| `EndpointTree` | Mapa aninhado de endpoints, espelhado pelo cliente |
| `EndpointInput<E>` | O objeto de entrada da chamada — `body` usa o tipo de *input* do schema (podes omitir campos com default), `query`/`params` usam o tipo de *output* |
| `EndpointOutput<E>` | O tipo devolvido — o *output* do schema `result` (ou `unknown` sem `result`) |
| `Client<T>` | O tipo do cliente gerado a partir da árvore `T` |
| `HttpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `FetchLike` | `typeof fetch` |
| `ClientOptions` | Descrito acima |

## Erros comuns e soluções (FAQ)

**`No fetch implementation available — pass options.fetch.`**
O ambiente não tem `fetch` global (Node < 18, alguns bundlers antigos). Passa uma implementação: `createClient(api, { baseUrl, fetch: minhaImplementacao })`.

**Erro com `code: 'CLIENT_RESPONSE_MISMATCH'`.**
A resposta do servidor não corresponde ao schema `result` do endpoint — o cliente e o servidor estão dessincronizados (por exemplo, o backend deixou de devolver um campo). Atualiza o schema no cliente ou corrige o servidor; `error.details` contém o `ZodError` com os campos em falta.

**O pedido dá 401 e o `refresh` nunca é chamado.**
O `refresh` só corre se estiver definido em `ClientOptions` e apenas no primeiro 401 de cada pedido. Confirma que o passaste ao `createClient`.

**O `refresh` é chamado mas o pedido falha na mesma com 401.**
O cliente repete o pedido **uma** vez com o token novo; se voltar a dar 401, lança o erro (proteção contra ciclos). Verifica se o token devolvido por `refresh` é mesmo válido — e devolve `null` quando não conseguires renovar (por exemplo, sessão terminada).

**Os parâmetros de caminho aparecem por substituir no URL (`/projects/:id`).**
Passa-os em `params`, não em `query`: `client.projects.get({ params: { id: 'p1' } })`, e o nome tem de coincidir com o marcador do `path`.

**Recebi `undefined` em vez de dados.**
Respostas 204 (No Content) resolvem para `undefined` por definição — típico de endpoints DELETE.

**Posso usar isto num backend Node?**
Sim — funciona em qualquer sítio com `fetch` (Node 18+ inclui-o). É útil para chamar uma API Machize a partir de outra.

## Como se liga aos outros módulos

- **`@machize/fastify`** — o par natural do outro lado: as rotas do servidor também são descritas com Zod, e o formato de erro `{ error: { code, message } }` do `HttpError` é exatamente o que o SDK mapeia para `MachizeClientError.code`.
- **`@machize/auth`** — os endpoints `POST /auth/login` e `POST /auth/refresh` do backend fornecem os tokens que ligas a `getToken`/`refresh`.
- **`create-machize`** — com a flag `--ui`, o frontend gerado (`web/src/api.ts`) já usa `endpoint` + `createClient` deste pacote, incluindo a renovação de token quando a autenticação está ativa.
- **`@machize/core`** — deliberadamente **não** é dependência: o SDK só depende do Zod, para poder correr no browser sem arrastar o framework.
