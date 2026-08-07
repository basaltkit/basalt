# @machize/search-postgres

Driver de **pesquisa full-text em PostgreSQL** para o [`@machize/search`](https://www.npmjs.com/package/@machize/search): usa `tsvector`/`tsquery`/`ts_rank` do Postgres, com isolamento por tenant. Precisas deste módulo quando já tens Postgres e queres pesquisa relevante **sem** um serviço externo (Meilisearch/Elastic).

## O que este módulo resolve

Muitos SaaS já correm em Postgres. O Postgres tem full-text search a sério (stemming, ranking) via `tsvector`. Este driver liga o `@machize/search` a isso: uma tabela indexada por (index, tenant, id), `tsvector` com índice GIN, e pesquisas `ts_rank` sempre restringidas ao tenant.

## Instalação

```bash
pnpm add @machize/search-postgres @machize/search pg
```

O `pg` é o cliente que passas ao driver (uma `Pool` ou `Client`).

## Uso

```ts
import { Pool } from 'pg'
import { searchPlugin, defineIndex } from '@machize/search'
import { PostgresSearchDriver } from '@machize/search-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

searchPlugin({
  driver: new PostgresSearchDriver({ client: pool }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

`register` (chamado pelo `searchPlugin` no arranque) cria a tabela `machize_search` e o índice GIN. O `index`/`search`/`remove`/`clear` funcionam como em qualquer driver do `@machize/search`.

## Como funciona

- **Uma tabela** para todos os índices: `(idx, tenant_id, id, document jsonb, tsv tsvector)`, com índice GIN em `tsv`.
- Ao indexar, os campos pesquisáveis do documento alimentam `to_tsvector(<language>, …)` (default `english`, com stemming).
- Ao pesquisar, `tsv @@ plainto_tsquery(...)` filtra e `ts_rank` ordena; **todas** as queries têm `tenant_id = $tenant`, por isso os resultados nunca vazam entre tenants. Os `filters` viram condições `document->>'campo' = $valor` (ou `= ANY(...)` para arrays).

## Testável sem base de dados

O cliente `pg` é **injetável**, por isso a construção do SQL testa-se com um fake — sem Postgres:

```ts
new PostgresSearchDriver({ client: fakePgClient })
```

## Opções

| Opção | Default | Descrição |
|---|---|---|
| `client` | — (obrigatório) | `Pool`/`Client` do `pg` já ligado. |
| `table` | `machize_search` | Tabela partilhada por todos os índices. |
| `language` | `english` | Configuração de text-search (stemming/stop-words). |

## Como se liga aos outros módulos

- **`@machize/search`** — este é um driver desse pacote; a API (`defineIndex`, `search`, sincronização por hooks) vem de lá.
- Drivers irmãos: `MemorySearchDriver` (dev) e `MeilisearchDriver` (no core do search).
