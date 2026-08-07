# @machize/dashboard

Modelo "headless" (sem interface gráfica) de um painel de administração completo: métricas de faturação (MRR, ARR, churn), resumos de filas de trabalho e de auditoria, e um registo de secções que organiza os recursos numa navegação. Precisas dele quando queres montar o painel de gestão de um produto SaaS — a página "Overview" com números, a lista de recursos na barra lateral, o estado das filas.

## O que este módulo resolve

Quando geres um produto por subscrição (um **SaaS** — software vendido como serviço, pago mensal ou anualmente), há perguntas que fazes todos os dias: quanto estamos a faturar por mês? Quantos clientes ativos, em período experimental, em atraso? Quantos cancelaram? Calcular estes números à mão, a partir da lista de subscrições, é chato e fácil de errar (por exemplo: um plano anual de 300 € vale 25 €/mês de receita recorrente, não 300 €).

Este pacote traz esses cálculos prontos e testados: `computeBillingMetrics` transforma uma lista de subscrições e o catálogo de planos em MRR (receita mensal recorrente), ARR (receita anual) e contagens por estado e por plano; `churnRate` calcula a taxa de cancelamento; `summarizeQueue` e `summarizeAudit` resumem o estado das filas de trabalho e o registo de auditoria.

A segunda metade do pacote é estrutural: `defineDashboard` e as funções `*Section` deixam-te declarar as secções do teu painel ("Overview", "Projects", "Audit Log", "Queues") num único objeto navegável — a "shell" visual (React ou outra) lê `dashboard.nav()` para desenhar a barra lateral e `dashboard.section(key)` para saber o que mostrar em cada página. Tal como o `@machize/admin`, este pacote não desenha nada: só produz os modelos. E é seguro usar no browser — importa apenas **tipos** do `@machize/subscriptions`, sem código de servidor.

## Instalação

```bash
pnpm add @machize/dashboard
```

> Traz `@machize/admin` e `@machize/subscriptions` como dependências. Na prática vais querer também o `@machize/subscriptions` diretamente (para `definePlans`) e o `zod` se definires recursos.

## Começar em 5 minutos

Vamos calcular as métricas de faturação de um SaaS fictício e montar a estrutura do painel.

**Passo 1 — Define o catálogo de planos** (com `@machize/subscriptions`):

```ts
import { definePlans } from '@machize/subscriptions'

const plans = definePlans({
  free: { price: 0, features: {} },
  pro: { price: { monthly: 30, yearly: 300 }, features: {} }, // 30 €/mês ou 300 €/ano
  scale: { price: 'custom', features: {} },                    // preço negociado
})
```

**Passo 2 — Calcula as métricas** a partir das subscrições (vindas da tua base de dados ou API):

```ts
import { computeBillingMetrics, churnRate } from '@machize/dashboard'
import type { SubscriptionRecord } from '@machize/subscriptions'

const subscriptions: SubscriptionRecord[] = [
  { billableId: 'a', plan: 'pro', period: 'monthly', status: 'active' },   // +30 €/mês
  { billableId: 'b', plan: 'pro', period: 'yearly', status: 'active' },    // 300/12 = +25 €/mês
  { billableId: 'c', plan: 'pro', period: 'monthly', status: 'trialing' }, // trial → 0 €
  { billableId: 'd', plan: 'free', period: 'monthly', status: 'active' },  // +0 €
]

const metrics = computeBillingMetrics(subscriptions, plans)
console.log(metrics.mrr)    // 55       (receita mensal recorrente)
console.log(metrics.arr)    // 660      (mrr × 12)
console.log(metrics.active) // 3
console.log(metrics.byPlan) // { pro: 3, free: 1 }

console.log(churnRate(5, 100)) // 0.05 → perdemos 5% dos clientes no período
```

**Passo 3 — Declara a estrutura do painel:**

```ts
import { z } from 'zod'
import { defineResource } from '@machize/admin'
import {
  defineDashboard,
  metricsSection,
  resourceSection,
  auditSection,
  queueSection,
} from '@machize/dashboard'

const projects = defineResource({
  name: 'projects',
  schema: z.object({ id: z.string(), name: z.string() }),
})

const dashboard = defineDashboard({
  title: 'Machize Admin',
  sections: [
    metricsSection({ icon: 'gauge' }),        // página "Overview" com os números
    resourceSection(projects, { icon: 'folder' }), // CRUD de projetos
    auditSection(),                            // registo de auditoria
    queueSection(),                            // estado das filas
  ],
})
```

**Passo 4 — Usa o modelo na tua interface:**

```ts
console.log(dashboard.title) // 'Machize Admin'
console.log(dashboard.nav())
// [
//   { key: 'overview', label: 'Overview', icon: 'gauge' },
//   { key: 'projects', label: 'Projects', icon: 'folder' },
//   { key: 'audit', label: 'Audit Log' },
//   { key: 'queues', label: 'Queues' },
// ]
// → desenha a barra lateral com isto; em cada página:
const secao = dashboard.section('projects')
// secao.kind === 'resource' e secao.resource é o Resource → desenha um DataTable
```

## Guia de utilização

### Métricas de faturação — `computeBillingMetrics`

Recebe um "snapshot" (fotografia do momento) das subscrições e o catálogo de planos. Regras importantes, fiéis ao código:

- **MRR** conta apenas subscrições `active` com preço numérico. Preços anuais são divididos por 12.
- Trials (`trialing`), planos `custom` e planos desconhecidos contribuem **0** para o MRR (ainda não são receita recorrente), mas contam nas contagens.
- `byPlan` conta subscrições por plano em **todos** os estados.
- Valores arredondados a 2 casas decimais; `arr = mrr × 12`.

```ts
import { computeBillingMetrics } from '@machize/dashboard'

const m = computeBillingMetrics(subscriptions, plans)
// m: { mrr, arr, active, trialing, pastDue, canceled, byPlan }
```

No ecrã, isto costuma virar uma fila de cartões: "MRR 55 €", "ARR 660 €", "Ativos 3", "Trials 1".

### Taxa de cancelamento — `churnRate`

Clientes perdidos a dividir pelos clientes no início do período. Devolve uma fração entre 0 e 1 (multiplica por 100 para percentagem). Protegida contra divisão por zero:

```ts
import { churnRate } from '@machize/dashboard'

churnRate(5, 100) // 0.05  (5 %)
churnRate(3, 0)   // 0     (não havia clientes no início)
```

### Resumo de filas — `summarizeQueue`

Uma **fila de trabalho** (queue) é onde a aplicação guarda tarefas para executar em segundo plano (enviar emails, gerar relatórios…). Cada tarefa está num estado: à espera, ativa, concluída, falhada, adiada. Esta função preenche os estados em falta com 0, soma o total e marca a fila como saudável quando não há falhas:

```ts
import { summarizeQueue } from '@machize/dashboard'

summarizeQueue({ waiting: 2, active: 1, failed: 3 })
// { waiting: 2, active: 1, completed: 0, failed: 3, delayed: 0,
//   total: 6, healthy: false }   ← healthy = failed === 0
```

No ecrã: um cartão por fila, com o total e um indicador verde (`healthy: true`) ou vermelho.

### Resumo de auditoria — `summarizeAudit`

Um **registo de auditoria** (audit log) guarda "quem fez o quê": cada entrada tem um nome de evento (ex.: `auth:login`). Esta função agrupa e conta por evento, do mais frequente para o menos (empates por ordem alfabética):

```ts
import { summarizeAudit } from '@machize/dashboard'

summarizeAudit([
  { event: 'auth:login' },
  { event: 'billing:subscribed' },
  { event: 'auth:login' },
])
// [ { event: 'auth:login', count: 2 }, { event: 'billing:subscribed', count: 1 } ]
```

Aceita qualquer array de objetos com `event: string` — as entradas do `@machize/audit` servem diretamente.

### Estrutura do painel — `defineDashboard` e as secções

Quatro construtores de secção, todos a devolver um objeto `Section`:

| Construtor | `kind` | `key` default | `label` default |
|---|---|---|---|
| `metricsSection(options?)` | `'metrics'` | `'overview'` | `'Overview'` |
| `resourceSection(resource, options?)` | `'resource'` | `resource.name` | `resource.label` |
| `auditSection(options?)` | `'audit'` | `'audit'` | `'Audit Log'` |
| `queueSection(options?)` | `'queue'` | `'queues'` | `'Queues'` |

Todos aceitam `{ key?, label?, icon? }` (o `resourceSection` aceita `{ key?, icon? }` — o label vem sempre do recurso). O `icon` é apenas uma dica textual para a interface (ex.: o nome de um ícone lucide como `'gauge'`); este pacote não desenha ícones. Também podes construir uma `Section` à mão com `kind: 'custom'` para páginas tuas.

A shell visual percorre as secções e escolhe o que desenhar por `kind`: `metrics` → cartões com `computeBillingMetrics`; `resource` → `DataTable`/`ResourceForm` (de `@machize/admin-react` ou `@machize/admin-shadcn`) sobre `section.resource`; `audit` → lista com `summarizeAudit`; `queue` → cartões com `summarizeQueue`.

## Referência da API

### `computeBillingMetrics(subscriptions, plans): BillingMetrics`

| Parâmetro | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `subscriptions` | `SubscriptionRecord[]` (de `@machize/subscriptions`) | Sim | Snapshot das subscrições (`{ billableId, plan, period, status, … }`). |
| `plans` | `Record<string, PlanDefinition>` | Sim | Catálogo de planos (ex.: resultado de `definePlans`). |

`BillingMetrics`:

| Campo | Tipo | Descrição |
|---|---|---|
| `mrr` | `number` | Receita mensal recorrente das subscrições ativas (anuais ÷ 12), 2 casas decimais. |
| `arr` | `number` | `mrr × 12`. |
| `active` | `number` | Subscrições com estado `active`. |
| `trialing` | `number` | Em período experimental. |
| `pastDue` | `number` | Com pagamento em atraso (`past_due`). |
| `canceled` | `number` | Canceladas. |
| `byPlan` | `Record<string, number>` | Contagem por plano, todos os estados. |

### `churnRate(canceledInPeriod, activeAtStart): number`

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `canceledInPeriod` | `number` | Clientes perdidos no período. |
| `activeAtStart` | `number` | Clientes ativos no início. |

Devolve fração em `[0, 1]`, 2 casas decimais; `0` se `activeAtStart <= 0`.

### `summarizeQueue(counts): QueueSummary`

`QueueCounts` (entrada — tudo opcional, default 0): `waiting?`, `active?`, `completed?`, `failed?`, `delayed?` (todos `number`).

`QueueSummary` (saída): os cinco contadores preenchidos, mais `total: number` (soma) e `healthy: boolean` (`failed === 0`).

### `summarizeAudit(entries): { event: string; count: number }[]`

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `entries` | `{ event: string }[]` | Entradas de auditoria (qualquer objeto com `event`). |

Devolve contagens por evento, ordenadas por frequência descendente e depois alfabeticamente.

### `defineDashboard(config): Dashboard`

`DashboardConfig`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `title` | `string` | Não | `'Admin'` | Título do painel. |
| `sections` | `Section[]` | Sim | — | Secções, pela ordem de navegação. |

Classe `Dashboard`:

| Membro | Assinatura | Descrição |
|---|---|---|
| `title` | `string` | Título. |
| `sections` | `Section[]` | Todas as secções. |
| `section(key)` | `(key: string) => Section \| undefined` | Procura uma secção pela `key`. |
| `nav()` | `() => { key, label, icon? }[]` | Modelo da barra lateral. |

### `Section` (tipo)

| Campo | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `key` | `string` | Sim | Identificador único (usado em rotas/navegação). |
| `label` | `string` | Sim | Texto apresentado. |
| `kind` | `SectionKind` = `'metrics' \| 'resource' \| 'audit' \| 'queue' \| 'custom'` | Sim | Diz à interface o que desenhar. |
| `resource` | `Resource` (de `@machize/admin`) | Não | Presente nas secções `resource`. |
| `icon` | `string` | Não | Dica de ícone para a interface (ex.: nome lucide). |

### `resourceSection(resource, options?)`, `metricsSection(options?)`, `auditSection(options?)`, `queueSection(options?)`

Construtores de `Section` — defaults na tabela do guia acima. `options` é sempre opcional.

## Erros comuns e soluções (FAQ)

**"O MRR deu 0 mas tenho subscrições."** Verifica três coisas: (1) o `status` tem de ser exatamente `'active'` — trials não contam; (2) o nome do plano na subscrição tem de existir no catálogo passado (plano desconhecido soma 0 silenciosamente); (3) planos `price: 'custom'` somam 0 por definição.

**"Uma subscrição anual de 300 € só somou 25 € ao MRR."** Correto: MRR é receita **mensal** — o preço anual é dividido por 12 (`300 / 12 = 25`).

**"O `churnRate` devolve 0.05 e eu esperava 5."** Devolve uma fração, não percentagem. Multiplica por 100 para mostrar `5 %`.

**"`healthy` está `false` mas as tarefas falhadas são antigas."** `healthy` é simplesmente `failed === 0`. Limpa/reprocessa a dead-letter da fila para o indicador voltar a verde.

**"`dashboard.section('...')` devolve `undefined`."** A `key` não corresponde. Lembra-te dos defaults: `metricsSection` → `'overview'`, `auditSection` → `'audit'`, `queueSection` → `'queues'`, `resourceSection` → o `name` do recurso. Passa `{ key: '...' }` para controlar.

**"Posso usar este pacote no browser?"** Sim. Do `@machize/subscriptions` só importa **tipos** (apagados na compilação), por isso não arrasta código de servidor — as funções de métricas são seguras no frontend.

**"Duas secções com a mesma `key`."** O `section(key)` devolve a primeira encontrada. Dá `key`s únicas (ex.: `resourceSection(projects, { key: 'projects-arquivados' })`).

## Como se liga aos outros módulos

- **`@machize/admin`** — fornece o tipo `Resource` que as `resourceSection` transportam; a interface desenha cada uma com os view models do admin.
- **`@machize/admin-react` / `@machize/admin-shadcn`** — as camadas visuais: lêem `dashboard.nav()` para a barra lateral e, por secção, usam `DataTable`/`ResourceForm` (secções `resource`), cartões (`Card`/`Badge` do admin-shadcn) para `metrics` e `queue`, e listas para `audit`.
- **`@machize/subscriptions`** — origem dos tipos `SubscriptionRecord`, `PlanDefinition` e `BillingPeriod`, e do `definePlans` que produz o catálogo passado a `computeBillingMetrics`.
- **`@machize/queue` e `@machize/audit`** — as fontes naturais dos números: passa os contadores da fila a `summarizeQueue` e as entradas de auditoria a `summarizeAudit`.
- **`@machize/sdk`** — no frontend, os dados (subscrições, contadores, auditoria) chegam via cliente tipado do SDK e são resumidos aqui antes de ir para o ecrã.
