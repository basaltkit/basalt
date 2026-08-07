# @machize/search

Pesquisa full-text (texto integral) para o Machize: indexa e pesquisa documentos **por tenant**, com uma API tipada e um driver intercambiável — **em memória** para desenvolvimento/testes e **Meilisearch** para produção. Precisas deste módulo quando queres dar aos utilizadores uma caixa de pesquisa rápida e relevante sobre os seus dados (notas, projetos, clientes…).

## O que este módulo resolve

Pesquisar bem é mais do que um `WHERE ... LIKE '%texto%'`: precisas de **relevância** (os melhores resultados primeiro), correspondência por **prefixo**, e **isolamento por tenant** (o cliente A nunca vê dados do cliente B). Este módulo dá-te isso com:

- **Índices tipados** — declaras uma vez que campos são pesquisáveis e filtráveis.
- **Isolamento por tenant garantido** — todas as pesquisas são forçadas ao `tenantId`; um resultado nunca "vaza" entre tenants.
- **Driver intercambiável** — `MemorySearchDriver` (sem serviços, para dev/test) e `MeilisearchDriver` (produção). O teu código não muda ao trocar.
- **Indexação automática** — liga hooks de domínio (criado/atualizado/apagado) e o índice mantém-se sozinho.

## Instalação

```bash
pnpm add @machize/search
```

Depende apenas de `@machize/core`. O `MemorySearchDriver` funciona sem nada instalado; para produção aponta o `MeilisearchDriver` a um servidor Meilisearch.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { searchPlugin, SEARCH, defineIndex } from '@machize/search'

const app = await createApp({
  plugins: [
    searchPlugin({
      indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
    }),
  ],
}).boot()

const search = app.container.get(SEARCH)

// indexar (o documento traz o tenantId)
await search.index('notes', { id: '1', tenantId: 'acme', title: 'Olá mundo', body: 'primeira nota', folder: 'inbox' })

// pesquisar (o tenant vem do contexto do pedido, ou passas explicitamente)
const result = await search.search('notes', 'olá', { tenantId: 'acme', filters: { folder: 'inbox' } })
console.log(result.hits) // [{ id: '1', score, document }]
console.log(result.total)
```

## Indexação automática (hooks → índice)

Em vez de indexar à mão em cada sítio, liga os eventos de domínio ao índice — e ele mantém-se sozinho:

```ts
import { searchPlugin, defineIndex, syncRule } from '@machize/search'

searchPlugin({
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'] })],
  sync: [
    syncRule({
      hook: 'note:created', // ou note:updated
      index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }),
    }),
    syncRule({
      hook: 'note:deleted',
      index: 'notes',
      remove: (p) => ({ tenantId: p.tenantId, id: p.noteId }),
    }),
  ],
})
```

O `syncRule` valida os tipos contra o payload do hook. Devolve `null` no `document`/`remove` para saltar um evento.

## Como funciona a relevância (driver em memória)

O `MemorySearchDriver` tokeniza os campos pesquisáveis e pontua por **frequência do termo** com correspondência de **prefixo** (`qui` encontra `quick`). Exige que **todos** os termos da query estejam presentes (semântica AND), ordena por pontuação, e só pesquisa os campos declarados em `fields`. É determinístico e suficiente para desenvolvimento; em produção o Meilisearch dá relevância a sério (typo-tolerance, stemming, etc.).

## Produção com Meilisearch

```ts
import { searchPlugin, MeilisearchDriver, defineIndex } from '@machize/search'

searchPlugin({
  driver: new MeilisearchDriver({ host: 'http://localhost:7700', apiKey: process.env.MEILI_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

O driver fala diretamente com a REST API do Meilisearch (sem SDK). Cada documento recebe uma chave primária composta (`_pk`), por isso ids nunca colidem entre tenants; e **cada pesquisa é filtrada por `tenantId`**, garantindo o isolamento. `defineIndex(...).filterable` é declarado automaticamente como atributo filtrável no Meilisearch.

## Referência da API

### `searchPlugin(options?)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `driver` | `SearchDriver` | `MemorySearchDriver` | Backend de pesquisa. |
| `indexes` | `IndexDefinition[]` | `[]` | Índices a registar no arranque. |
| `sync` | `SyncRule[]` | `[]` | Regras hook → índice (usa `syncRule(...)`). |

Regista o token `SEARCH` (`Search`).

### `class Search`

| Método | Descrição |
|---|---|
| `index(indexName, document)` | Indexa/atualiza um documento (traz `id` e `tenantId`). |
| `bulk(indexName, documents)` | Indexa vários. |
| `remove(indexName, id, tenantId?)` | Remove um documento (tenant do contexto se omitido). |
| `search(indexName, q, options?)` | Pesquisa. `options`: `tenantId?`, `filters?`, `limit?`, `offset?`. |

Sem `tenantId` explícito, `search`/`remove` usam `ctx().tenant.id`; se não houver tenant, lançam `TenantRequiredError`.

### `defineIndex({ name, fields, filterable? })`

Declara um índice: `fields` são pesquisáveis (full-text), `filterable` são usáveis em `filters` (`tenantId` é sempre filtrável).

### Drivers

- `MemorySearchDriver` — em processo, dev/test.
- `MeilisearchDriver({ host, apiKey?, fetch? })` — produção; `fetch` injetável para testes.

## Como se liga aos outros módulos

- **`@machize/core`** — `createApp`, tokens, hooks (que a sincronização automática consome) e o contexto de onde vem o `tenantId`.
- **`@machize/tenancy`** — coloca o `tenant` no contexto; com ele ativo, `search.search('notes', q)` já sabe o tenant.
- **`@machize/events`** — emite os eventos de domínio que alimentam a `sync`.
