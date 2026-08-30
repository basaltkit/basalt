# Pesquisa

O `@basaltkit/search` dá à tua app pesquisa full-text que é **restrita ao tenant
por construção** — cada query é forçada ao tenant de quem a faz, por isso os
resultados nunca vazam entre tenants. Numa app sem `tenancyPlugin` não há tenant
a que delimitar: o `tenantId` passa a opcional no `index()` e no `search()`, e
ambos resolvem para um único âmbito interno `'default'`, por isso concordam
sempre (vê [Para além do SaaS](/pt/guide/beyond-saas)). Traz um driver em memória para dev/testes e
um driver Meilisearch para produção, atrás de uma única API.

[[toc]]

## Configuração

```ts
import { createApp } from '@basaltkit/core'
import { searchPlugin, SEARCH, defineIndex } from '@basaltkit/search'

const app = await createApp({
  plugins: [
    searchPlugin({
      indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
    }),
  ],
}).boot()

const search = app.container.get(SEARCH)
```

`defineIndex` declara que campos são pesquisáveis (`fields`) e quais podem ser
filtrados (`filterable`); `tenantId` é sempre filtrável.

## Indexar e consultar

```ts
// indexar — o documento carrega o seu id e tenantId
await search.index('notes', { id: '1', tenantId: 'acme', title: 'Hello world', body: 'first note', folder: 'inbox' })

// consultar — tenant vindo das opções, ou do contexto do pedido
const result = await search.search('notes', 'hello', { tenantId: 'acme', filters: { folder: 'inbox' } })
result.hits // [{ id, score, document }] — mais relevantes primeiro
result.total
```

Dentro de um pedido, o tenant vem de `ctx().tenant` automaticamente:

```ts
import { z } from 'zod'
import { route } from '@basaltkit/fastify'
import { SEARCH } from '@basaltkit/search'
import { app } from './app.js'

const search = app.container.get(SEARCH)

export const searchNotes = route({
  method: 'GET',
  url: '/search',
  query: z.object({ q: z.string() }),
  handler: ({ query }) => search.search('notes', query.q), // tenant implícito
})
```

Se nenhum tenant puder ser determinado, `search`/`remove` lançam
`TenantRequiredError`.

Para semear um índice (backfill, migração), `bulk` faz upsert de vários
documentos de uma só vez — cada um continua a carregar o seu próprio `tenantId`:

```ts
await search.bulk('notes', [
  { id: '1', tenantId: 'acme', title: 'Hello world', body: 'first note' },
  { id: '2', tenantId: 'acme', title: 'Release plan', body: 'ship it' },
])
```

## Relevância (driver em memória)

O `MemorySearchDriver` tokeniza os campos pesquisáveis e pontua por **frequência
de termos** com **correspondência por prefixo** (`qui` corresponde a `quick`).
Exige que cada termo da query corresponda (semântica **AND**) e pesquisa apenas
os campos declarados. É determinístico e sem dependências — ideal para dev e
testes. A relevância de produção (tolerância a erros, stemming) é trabalho do
driver Meilisearch.

## Manter o índice sincronizado

Liga hooks de domínio ao índice e ele mantém-se sozinho:

```ts
import { searchPlugin, defineIndex, syncRule } from '@basaltkit/search'

searchPlugin({
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'] })],
  sync: [
    syncRule({ hook: 'note:created', index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }) }),
    syncRule({ hook: 'note:updated', index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }) }),
    syncRule({ hook: 'note:deleted', index: 'notes',
      remove: (p) => ({ tenantId: p.tenantId, id: p.noteId }) }),
  ],
})
```

O `document` faz upsert de um documento (no create/update); o `remove` apaga um.
Devolve `null` para saltar um evento.

### Emitir o hook no teu código

O `sync` apenas *reage* — algo tem de **emitir** o hook no `HookBus` do core.
Passa-o ao teu serviço (os plugins recebem-no no `register`/`boot`) e emite
depois da escrita:

```ts
// post.plugin.ts — passar o HookBus ao serviço
register({ container, hooks }) {
  container.singleton(POST_SERVICE, (c) => new PostService(c.get(POST_REPOSITORY), hooks))
}

// post.service.ts — emitir depois de persistir
async create(input) {
  const post = await this.repository.create(input)
  await this.hooks.emit('post:created', { tenantId: ctx().tenant?.id ?? 'demo', id: post.id, name: post.name })
  return post
}
```

### Tipar os payloads dos hooks

O `BasaltHooks` tem uma index signature (`[hook: string]: unknown`), por isso um
hook funciona em runtime **sem** o declarar. Mas então o payload é `unknown`, e os
mappers `document` / `remove` não verificam tipos (`p.id` dá erro). Declara os
payloads uma vez — em qualquer ficheiro que entre na compilação — para teres
segurança de tipos total no `emit` e no `syncRule`:

```ts
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'post:created': { tenantId: string; id: string; name: string }
    'post:updated': { tenantId: string; id: string; name: string }
    'post:deleted': { tenantId: string; id: string }
  }
}
```

::: tip Não é obrigatória para correr
A declaração não é necessária para o código funcionar — é o que torna o `emit()` e
os mappers do `syncRule` type-safe. Sem ela, o payload é `unknown` (terias de fazer
cast, ou anotar cada mapper à mão).
:::

## Produção com Meilisearch

```ts
import { searchPlugin, MeilisearchDriver, defineIndex } from '@basaltkit/search'

searchPlugin({
  driver: new MeilisearchDriver({ host: process.env.MEILI_HOST!, apiKey: process.env.MEILI_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

O driver fala diretamente com a API REST do Meilisearch (sem SDK). Cada documento
recebe uma chave primária composta para que os ids nunca colidam entre tenants, e
**cada pesquisa é restringida com um filtro `tenantId`** — a mesma garantia de
isolamento do driver em memória. Os teus campos `filterable` são declarados
automaticamente como atributos filtráveis do Meilisearch.

## Já estás em Postgres?

Se preferires não correr um serviço de pesquisa separado, o
`@basaltkit/search-postgres` usa a pesquisa full-text nativa do Postgres
(`tsvector` / `ts_rank`) — traz o teu cliente `pg`:

```ts
import { PostgresSearchDriver } from '@basaltkit/search-postgres'
searchPlugin({ driver: new PostgresSearchDriver({ client: pgPool }), indexes: [/* … */] })
```

Cria uma tabela com índice GIN para todos os índices, alimenta os campos
pesquisáveis para `to_tsvector`, ordena com `ts_rank` e restringe cada query ao
tenant — a mesma garantia de isolamento, sem infraestrutura adicional.

A `table` pode ser qualificada com schema (`table: 'app.search'`); o índice GIN
é nomeado com o separador achatado (`app_search_tsv_idx`), porque o Postgres não
permite um nome de índice qualificado com schema. Continua a ficar no schema da
própria tabela.

## Elasticsearch / OpenSearch

Para relevância em grande escala, o `@basaltkit/search-elasticsearch` aponta
diretamente à API REST do Elasticsearch 8.x / OpenSearch 2.x (sem SDK), com um
`fetch` injetável:

```ts
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

searchPlugin({
  driver: new ElasticsearchDriver({ node: process.env.ES_NODE!, apiKey: process.env.ES_API_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

`register` mapeia os campos pesquisáveis como `text` (com um sub-campo
`.keyword`) e os campos filtráveis como `keyword`; `search` usa `multi_match` com
um `track_total_hits` exato. Os documentos recebem um id composto
`<tenantId>:<id>` — com **cada segmento percent-encoded**, para que um `:` dentro
de um id de tenant ou de documento não faça o tenant `a:b` + id `c` colidir com o
tenant `a` + id `b:c` — e **cada pesquisa carrega um filtro `tenantId`
obrigatório**, a mesma garantia de isolamento de qualquer outro driver. Ids
simples de UUID/slug não são alterados pela codificação.

::: warning Aviso: password vs API key
`username` + `password` usam **Basic auth** HTTP. `apiKey` envia o header
`Authorization: ApiKey <key>` e espera uma **API key** de
`POST /_security/api_key` — não a password do teu utilizador. Passar a password
como `apiKey` devolve `401`.
:::

## Testar a tua ligação ao Elasticsearch

Antes (ou depois) de a ligar à tua app, confirma que o cluster e as credenciais
funcionam de ponta a ponta.

**1. Ping ao cluster** — está acessível e as credenciais são válidas?

```bash
curl -u elastic:$ELASTICSEARCH_PASSWORD http://localhost:9200     # Basic auth
curl -H "Authorization: ApiKey $ES_API_KEY" http://localhost:9200 # ou uma API key
```

Um corpo JSON com `version.number` significa que entraste. Um
`401 security_exception` significa que as credenciais estão erradas.

**2. Smoke-test ao driver** — indexa um documento descartável, pesquisa-o,
verifica o isolamento por tenant e depois limpa. Guarda como `smoke.mjs` e corre
`node --env-file=.env smoke.mjs`:

```ts
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

const driver = new ElasticsearchDriver({
  node: process.env.ELASTICSEARCH_URL,
  username: process.env.ELASTICSEARCH_USERNAME, // ou apiKey: process.env.ES_API_KEY
  password: process.env.ELASTICSEARCH_PASSWORD,
  refresh: 'wait_for', // torna as escritas visíveis de imediato (apenas testes)
})

const INDEX = 'basalt_smoke_test'
await driver.register({ name: INDEX, fields: ['title'], filterable: [] })
await driver.index(INDEX, { id: '1', tenantId: 'demo', title: 'Hello Basalt' })

const found = await driver.search(INDEX, { tenantId: 'demo', q: 'hello' })
console.log('found:', found.total, found.hits[0]?.document.title) // → 1 'Hello Basalt'

const other = await driver.search(INDEX, { tenantId: 'other', q: 'hello' })
console.log('other tenant sees:', other.total) // → 0  (o isolamento mantém-se)

await driver.clear(INDEX) // não deixar rasto
```

Ver `found: 1 'Hello Basalt'` e `other tenant sees: 0` confirma que a indexação,
a relevância e o isolamento por tenant funcionam todos contra o teu cluster.

**3. Na app** — `searchPlugin` chama `register` para cada índice no arranque, por
isso uma ligação má ou credenciais más **falham logo no arranque**. Se a app
arrancar, a ligação está boa; depois é só chamar a tua rota de pesquisa.

## Filtros e paginação

```ts
await search.search('notes', 'report', {
  tenantId: 'acme',
  filters: { folder: 'work' },        // correspondência exata; um array significa "qualquer um de"
  limit: 20,
  offset: 40,
})
```

## Referência

| API | Objetivo |
| --- | --- |
| `defineIndex({ name, fields, filterable? })` | Declarar um índice. |
| `searchPlugin({ driver?, indexes?, sync? })` | Registar o serviço, índices e regras de sync. |
| `SEARCH` | Token de DI → o serviço `Search`. |
| `search.index/bulk/remove/search` | Indexar, indexar em bloco, remover, consultar. |
| `MemorySearchDriver` · `MeilisearchDriver` | Backends de dev/teste e de produção. |

Vê o [cookbook de notes SaaS](/pt/cookbook/notes-saas) para pesquisa numa app
completa.
