# @machize/audit-viewer

Visualizador **só de leitura** do rasto de auditoria do [`@machize/audit`](https://www.npmjs.com/package/@machize/audit): consultas **por tenant**, filtráveis e paginadas, com **estatísticas** agregadas, e uma **página HTML** self-contained para navegar. Precisas deste módulo quando queres dar a administradores (ou a ti) uma forma de rever quem fez o quê — para suporte, conformidade ou depuração.

## O que este módulo resolve

O `@machize/audit` grava um rasto *append-only* (imutável) de tudo o que acontece. Este módulo é a lente para o ler: filtrar por evento/ator/período/origem, paginar, ver totais e distribuições — e uma página pronta a abrir no browser. Nunca escreve nem altera o rasto.

## Instalação

```bash
pnpm add @machize/audit-viewer @machize/audit
```

Depende do `@machize/core`, `@machize/audit` e `@machize/fastify`. Requer o `auditPlugin` registado (é de lá que vem o rasto).

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { auditPlugin } from '@machize/audit'
import { auditViewerPlugin, auditViewerRoutes, AUDIT_VIEWER } from '@machize/audit-viewer'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    auditPlugin(),
    auditViewerPlugin(),
    fastifyPlugin({ routes: [...auditViewerRoutes()] }),
  ],
}).boot()

// programaticamente
const viewer = app.container.get(AUDIT_VIEWER)
const page = await viewer.page({ tenantId: 'acme', event: 'auth:**', limit: 50 })
const stats = await viewer.stats({ tenantId: 'acme' })
```

## Rotas

`auditViewerRoutes()` (todas exigem login — junta o teu *guard* de admin por cima):

| Rota | Descrição |
|---|---|
| `GET /audit?event=&actorId=&source=&since=&until=&limit=&offset=` | Página de entradas (mais recentes primeiro) + `total`. |
| `GET /audit/stats?…` | Agregados: por evento, por ator, por origem, linha temporal. |
| `GET /audit/:id` | Uma entrada. |
| `GET /audit/view` | Página HTML para navegar (filtros + tabela + paginação). |

Todas são **isoladas por tenant** (o tenant vem do contexto do pedido).

## A página HTML

`GET /audit/view` serve uma página vanilla (sem build, sem dependências) que chama as rotas JSON e mostra uma tabela filtrável com paginação. Personaliza o título/base:

```ts
auditViewerRoutes({ title: 'Auditoria — Acme', apiBase: '/admin' })
```

## Referência da API

### `auditViewerPlugin({ bucketMs?, topN? })`

Regista o token `AUDIT_VIEWER`. `bucketMs` é o tamanho do balde da linha temporal (default 1 dia); `topN` limita as tabelas por-evento/ator (default 20).

### `class AuditViewer`

| Método | Descrição |
|---|---|
| `page(query)` | `{ entries, total, limit, offset }`. |
| `stats(query)` | `{ total, byEvent, byActor, bySource, timeline }`. |
| `get(id, tenantId?)` | Uma entrada, ou `null`. |

`ViewerQuery`: `event` (wildcard), `actorId`, `tenantId`, `source` (`hook`/`event`/`manual`), `since`, `until`, `limit`, `offset`. Sem `tenantId`, usa `ctx().tenant.id` (senão `AuditTenantRequiredError`).

> Nota: o filtro extra (source/until) e a agregação são feitos em memória sobre o resultado do `Audit.trail`. Para rastos muito grandes, usa um `AuditStore` com consulta rica na base de dados.

## Como se liga aos outros módulos

- **`@machize/audit`** — a fonte imutável do rasto (este módulo só lê).
- **`@machize/permissions`** — adiciona um *guard* (`meta.can: 'audit:read'`) para restringir a admins.
- **`@machize/exports`** — exporta o resultado de uma consulta para CSV para relatórios de conformidade.
