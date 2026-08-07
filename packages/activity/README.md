# @machize/activity

Registo de atividade (activity log) para aplicações Machize: um feed do estilo "Maria publicou o projeto X há 5 minutos", construído com uma API fluente e automaticamente associado ao utilizador e ao tenant atuais.

Precisas deste módulo quando queres mostrar aos utilizadores um **histórico legível** do que aconteceu — na página de um projeto, no perfil de um utilizador, num painel de equipa. (Inspirado no `spatie/laravel-activitylog` do mundo Laravel.)

---

## O que este módulo resolve

Um **registo de atividade** guarda ações em formato pensado para pessoas: quem fez (**causer** — o causador), sobre o quê (**subject** — o sujeito, ex.: o projeto "p1"), o que fez (uma descrição como `'published'`) e detalhes extra (**properties**, ex.: `{ from: 'draft', to: 'published' }`). Com estes campos consegues montar feeds como "atividade recente deste projeto" ou "tudo o que este utilizador fez".

Escrever isto à mão em cada ação é repetitivo e propenso a esquecimentos — sobretudo o "quem" e o "de que organização". Este módulo lê o **contexto ativo** da aplicação (`@machize/core`): se houver `user`/`tenant` no contexto, o registo sai com `causerId` e `tenantId` preenchidos sem passares nada. A escrita fica numa linha fluente: `activity.in('project').performedOn('project', id).log('published')`.

Numa aplicação multi-tenant (vários clientes na mesma base de dados) há ainda o perigo de um feed mostrar atividade de outra organização. Por omissão, as **consultas são limitadas ao tenant do contexto** (`tenantScoped: true`): dentro do tenant "acme" só vês registos da "acme"; fora de qualquer tenant (contexto central/admin) vês tudo.

## Instalação

```bash
pnpm add @machize/activity
```

Depende apenas de `@machize/core`. O armazenamento por omissão é em memória (`MemoryActivityStore`) — em produção fornece um `ActivityStore` persistente (ver "Store personalizado").

## Começar em 5 minutos

**1. Regista o plugin:**

```ts
import { createApp } from '@machize/core'
import { ACTIVITY, activityPlugin } from '@machize/activity'

const app = await createApp({
  plugins: [activityPlugin()],
}).boot()

const activity = app.container.get(ACTIVITY)
```

**2. Regista uma ação** (dentro de um pedido, o utilizador e o tenant vêm do contexto):

```ts
import { runWithContext } from '@machize/core'

await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
  const record = await activity
    .in('project')                                  // log com nome 'project'
    .performedOn('project', 'p1')                   // sujeito: o projeto p1
    .withProperties({ from: 'draft', to: 'published' })
    .log('published')                               // descrição + grava

  // record.causerId === 'u1', record.tenantId === 'acme'
})
```

**3. Lê o feed do projeto (mais recente primeiro):**

```ts
const feed = await activity.for('project', 'p1')
for (const record of feed) {
  console.log(`${record.causerId} ${record.description}`, record.properties)
}
```

## Guia de utilização

### O builder fluente

`activity.in(nomeDoLog)` inicia um `ActivityBuilder`; todos os passos são opcionais exceto o `log(descrição)` final, que grava e devolve o registo:

```ts
const record = await activity
  .in('billing')                       // agrupa em logs nomeados ('default' se omitido)
  .performedOn('invoice', 'i1')        // sujeito (tipo + id)
  .causedBy('system')                  // força o causador (senão vem de ctx().user.id)
  .withProperties({ amount: 4900 })    // detalhes extra
  .log('generated')
```

Atalho para o log por omissão:

```ts
await activity.performedOn('invoice', 'i1').log('generated') // log: 'default'
```

Os registos devolvidos são congelados (`Object.freeze`) — imutáveis depois de criados.

### Consultar feeds

Todos devolvem os registos **mais recentes primeiro**, com limite por omissão de 20:

```ts
await activity.for('project', 'p1')        // feed de um sujeito
await activity.for('project', 'p1', 50)    // com limite explícito
await activity.inLog('billing')            // feed de um log nomeado
await activity.byCauser('u1')              // tudo o que u1 fez
await activity.query({                     // consulta livre
  log: 'project',
  subjectType: 'project',
  causerId: 'u1',
  limit: 10,
})
```

### Isolamento por tenant

Com `tenantScoped: true` (o default), qualquer consulta feita **dentro** de um contexto com tenant é automaticamente filtrada por esse tenant:

```ts
import { runWithContext } from '@machize/core'
import { Activity } from '@machize/activity'

const activity = new Activity()

await runWithContext({ tenant: { id: 'acme' } }, () =>
  activity.performedOn('project', 'p1').log('acme thing'),
)
await runWithContext({ tenant: { id: 'globex' } }, () =>
  activity.performedOn('project', 'p1').log('globex thing'),
)

// dentro do tenant acme: só vê o registo da acme
const acmeFeed = await runWithContext({ tenant: { id: 'acme' } }, () =>
  activity.for('project', 'p1'),
) // → ['acme thing']

// fora de qualquer tenant (admin/central): vê tudo
await activity.for('project', 'p1') // → 2 registos
```

Para desligar: `new Activity({ tenantScoped: false })` ou `activityPlugin({ tenantScoped: false })`. Passar `tenantId` explícito na `query` também ignora o scoping automático.

### Uso sem plugin (scripts, testes)

```ts
import { Activity } from '@machize/activity'

const activity = new Activity()           // MemoryActivityStore por omissão
await activity.in('test').log('works')
```

### Store personalizado (produção)

O store em memória perde tudo ao reiniciar. Implementa `ActivityStore` sobre a tua base de dados:

```ts
import type { ActivityQuery, ActivityRecord, ActivityStore } from '@machize/activity'
import { activityPlugin } from '@machize/activity'

class SqlActivityStore implements ActivityStore {
  async append(record: ActivityRecord): Promise<void> {
    // INSERT na tabela activity_log…
  }
  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    // SELECT com filtros, ORDER BY at DESC, LIMIT…
    return []
  }
}

activityPlugin({ store: new SqlActivityStore() })
```

## Referência da API

### `activityPlugin(options?: ActivityOptions)`

Regista `new Activity(options)` como singleton no token `ACTIVITY`.

### `class Activity`

`new Activity(options?: ActivityOptions)`

`ActivityOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `ActivityStore` | Não | `new MemoryActivityStore()` | Onde os registos são guardados. |
| `tenantScoped` | `boolean` | Não | `true` | Filtra consultas pelo `ctx().tenant` automaticamente. |

Métodos:

| Método | Assinatura | Descrição |
|---|---|---|
| `in` | `(logName: string) => ActivityBuilder` | Inicia um builder num log nomeado. |
| `performedOn` | `(type: string, id: string) => ActivityBuilder` | Atalho: builder no log `'default'` já com sujeito. |
| `for` | `(type: string, id: string, limit = 20) => Promise<ActivityRecord[]>` | Feed de um sujeito, mais recente primeiro. |
| `inLog` | `(logName: string, limit = 20) => Promise<ActivityRecord[]>` | Feed de um log nomeado. |
| `byCauser` | `(userId: string, limit = 20) => Promise<ActivityRecord[]>` | Feed de um causador. |
| `query` | `(query: ActivityQuery) => Promise<ActivityRecord[]>` | Consulta livre (com tenant-scoping automático, se ativo). |

### `class ActivityBuilder` (criada por `in`/`performedOn`)

| Método | Assinatura | Descrição |
|---|---|---|
| `performedOn` | `(type: string, id: string) => this` | Define o sujeito. |
| `causedBy` | `(userId: string) => this` | Força o causador (default: `ctx().user.id` na hora do `log`). |
| `withProperties` | `(properties: Record<string, unknown>) => this` | Detalhes extra do registo. |
| `log` | `(description: string) => Promise<ActivityRecord>` | Grava e devolve o registo (congelado). |

### `interface ActivityRecord` (todos os campos `readonly`)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string` | UUID gerado no registo. |
| `log` | `string` | Nome do log (`'default'` se não definido). |
| `description` | `string` | A ação, em texto (ex.: `'published'`). |
| `subjectType` | `string \| undefined` | Tipo do sujeito (ex.: `'project'`). |
| `subjectId` | `string \| undefined` | Id do sujeito. |
| `causerId` | `string \| undefined` | Quem fez — `causedBy(...)` ou `ctx().user.id`. |
| `tenantId` | `string \| undefined` | `ctx().tenant.id` no momento do registo. |
| `properties` | `Record<string, unknown> \| undefined` | Detalhes extra. |
| `at` | `number` | Timestamp (`Date.now()`, milissegundos). |

### `interface ActivityQuery`

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `log` | `string` | Não | todos | Filtra por log nomeado. |
| `subjectType` | `string` | Não | todos | Filtra por tipo de sujeito. |
| `subjectId` | `string` | Não | todos | Filtra por id de sujeito. |
| `causerId` | `string` | Não | todos | Filtra por causador. |
| `tenantId` | `string` | Não | tenant do contexto (se `tenantScoped`) | Filtra por tenant; passar valor explícito ignora o scoping automático. |
| `limit` | `number` | Não | sem limite (métodos de feed usam 20) | Máximo de resultados. |

### `interface ActivityStore`

Contrato de armazenamento:

- `append(record: ActivityRecord): Promise<void>`
- `query(query: ActivityQuery): Promise<ActivityRecord[]>` — deve devolver mais recente primeiro e aplicar filtros/limit.

### `class MemoryActivityStore`

Implementação em memória (congela cada registo; filtra e inverte na consulta). Para dev e testes; não persiste.

### Token

- `ACTIVITY: Token<Activity>` — `app.container.get(ACTIVITY)`.

## Erros comuns e soluções (FAQ)

**`causerId`/`tenantId` vêm vazios nos registos.**
Não havia contexto ativo (com `user`/`tenant`) no momento do `log(...)`. Dentro de pedidos HTTP o middleware estabelece o contexto; em scripts usa `runWithContext({ user: {...}, tenant: {...} }, …)` ou força com `.causedBy('system')`.

**O feed vem vazio, mas sei que há registos.**
Provavelmente é o tenant-scoping: estás a consultar dentro de um tenant diferente daquele em que os registos foram criados. Confirma o tenant do contexto, passa `tenantId` explícito na `query`, ou cria a `Activity` com `tenantScoped: false`.

**Só recebo 20 resultados.**
Os métodos de feed (`for`, `inLog`, `byCauser`) têm `limit = 20` por omissão. Passa o limite como último argumento, ou usa `query({ ... , limit: 100 })`.

**Posso alterar um registo depois de criado?**
Não — os registos são congelados no `append`. Se algo mudou, regista uma nova atividade (ex.: `'renamed'`).

**Perdi o histórico ao reiniciar o processo.**
O `MemoryActivityStore` é volátil. Em produção implementa `ActivityStore` sobre a base de dados.

**Devo usar activity ou audit?**
Atividade: feed legível para o **utilizador final** ("Maria publicou…"), escrito por ti nos pontos que interessam ao produto. Auditoria (`@machize/audit`): registo automático e imutável para **segurança/compliance**, capturado de hooks e eventos. Muitas aplicações usam ambos.

## Como se liga aos outros módulos

- **`@machize/core`** — fonte do contexto (`tryCtx`) que preenche `causerId`/`tenantId` e alimenta o tenant-scoping; o plugin usa `definePlugin`/`createToken`.
- **`@machize/audit`** — módulo irmão: auditoria é o registo de segurança automático e append-only; atividade é o feed de produto escrito explicitamente. Vê a FAQ acima.
- **`@machize/queue`** — o contexto viaja para os workers, por isso atividade registada dentro de um job mantém o causador/tenant do pedido que o despachou.
- **`@machize/events`** — podes registar atividade dentro de listeners de eventos de domínio (ex.: ao ouvir `order.created`, registar "encomenda criada" no feed do cliente).
- **`@machize/logger`** — os logs técnicos são para operadores; a atividade é para utilizadores. Complementam-se.
