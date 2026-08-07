# @machize/audit

Trilho de auditoria (audit trail) para aplicações Machize: regista automaticamente, num histórico imutável, quem fez o quê e quando — a partir dos hooks do ciclo de vida, dos eventos de domínio e de registos manuais.

Precisas deste módulo quando tens de conseguir responder a perguntas como "quem entrou nesta conta?", "quem alterou este plano de faturação?" — por razões de segurança, suporte ou conformidade legal (compliance).

---

## O que este módulo resolve

**Auditoria** é o registo sistemático de ações relevantes num sistema: logins, alterações de faturação, mudanças de permissões. Ao contrário dos logs técnicos (que são para programadores e podem ser apagados), o trilho de auditoria é um registo de negócio: **append-only** (só se acrescenta, nunca se altera nem apaga) e enriquecido com o **ator** (quem fez), o **tenant** (a que organização pertence) e o **pedido** (requestId) — tudo capturado automaticamente do contexto ativo no momento do registo.

A parte trabalhosa da auditoria é lembrarmo-nos de registar em todo o lado. Este módulo resolve isso ligando-se ao que a aplicação já emite: os **hooks** de ciclo de vida do `@machize/core` (ex.: `auth:login`, `billing:subscribed`) e os **eventos de domínio** do `@machize/events` (ex.: `order.created`). Escolhes com padrões wildcard o que fica registado — por omissão, toda a atividade de `auth`, `billing`, `tenancy` e `permission` (hooks) e **todos** os eventos.

Cada entrada é congelada (`Object.freeze`) — nem por engano o código consegue adulterar o histórico em memória. Para consultar, usas `audit.trail()` com filtros por evento (com wildcards), tenant, ator e data.

## Instalação

```bash
pnpm add @machize/audit
```

Depende de `@machize/core` e `@machize/events`. O armazenamento por omissão é em memória (`MemoryAuditStore`) — para produção deves fornecer um `AuditStore` persistente (ver "Store personalizado").

## Começar em 5 minutos

**1. Regista o plugin (junto com o de eventos, se o usares):**

```ts
import { createApp } from '@machize/core'
import { eventsPlugin } from '@machize/events'
import { AUDIT, auditPlugin } from '@machize/audit'

const app = await createApp({
  plugins: [eventsPlugin(), auditPlugin()],
}).boot()
```

**2. A partir daqui, os hooks e eventos relevantes ficam registados sozinhos.** Por exemplo, quando o módulo de autenticação emite o hook `auth:login`, nasce uma entrada de auditoria com o ator e o tenant do contexto.

**3. Consulta o trilho:**

```ts
const audit = app.container.get(AUDIT)

const trail = await audit.trail()               // tudo, mais recente primeiro
const logins = await audit.trail({ event: 'auth:**' })
console.log(logins[0])
// {
//   id: '4f1c…', source: 'hook', event: 'auth:login',
//   payload: { user: { id: 'u1', email: 'a@b.c' } },
//   actorId: 'u1', tenantId: 'acme', requestId: 'req-1', at: 1754500000000
// }
```

**4. Regista manualmente o que os hooks não cobrem:**

```ts
await audit.record('data.export', { format: 'csv' })
```

## Guia de utilização

### Captura automática de hooks

Por omissão são gravados os hooks que casem com `auth:**`, `billing:**`, `tenancy:**` ou `permission:**`. Podes trocar a lista:

```ts
import { auditPlugin } from '@machize/audit'

auditPlugin({
  hooks: ['auth:**', 'billing:**', 'api-keys:**'], // substitui os defaults
})
```

O enriquecimento vem do contexto ativo: `ctx().user.id` → `actorId`, `ctx().tenant.id` → `tenantId`, `ctx().requestId` → `requestId`.

### Captura automática de eventos de domínio

Se o contentor tiver um `EventBus` (`@machize/events` registado), o plugin subscreve `**` e grava os eventos que casem com os padrões. Por omissão grava **tudo**; afina ou desliga:

```ts
auditPlugin({ events: ['order.**', 'invoice.**'] }) // só estes
auditPlugin({ events: [] })                          // desliga a captura de eventos
```

### Registos manuais

Para ações que nenhum hook/evento cobre:

```ts
import { runWithContext } from '@machize/core'

await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
  const entry = await audit.record('data.export', { format: 'csv' })
  // entry.source === 'manual', entry.actorId === 'u1', entry.tenantId === 'acme'
})
```

`record` devolve a entrada criada (já congelada).

### Consultar o trilho

`trail(query)` devolve as entradas **mais recentes primeiro**:

```ts
await audit.trail({ event: 'auth:**' })         // wildcard sobre o nome
await audit.trail({ tenantId: 'acme' })          // só de um tenant
await audit.trail({ actorId: 'u1' })             // só de um utilizador
await audit.trail({ since: Date.now() - 86_400_000 }) // últimas 24h
await audit.trail({ limit: 50 })                 // no máximo 50
```

Os padrões de evento suportam segmentos separados por `:` (hooks) ou `.` (eventos): `*` casa um segmento, `**` casa um ou mais. Ex.: `auth:*` casa `auth:login`; `order.**` casa `order.created` e `order.item.added`; `**` casa tudo.

### Store personalizado (produção)

O `MemoryAuditStore` perde tudo quando o processo termina. Em produção implementa `AuditStore` sobre a tua base de dados — o contrato é append-only (sem update nem delete):

```ts
import type { AuditEntry, AuditQuery, AuditStore } from '@machize/audit'
import { auditPlugin } from '@machize/audit'

class SqlAuditStore implements AuditStore {
  async append(entry: AuditEntry): Promise<void> {
    // INSERT na tabela audit_entries…
  }
  async query(query: AuditQuery): Promise<AuditEntry[]> {
    // SELECT com filtros, ORDER BY at DESC, LIMIT…
    return []
  }
}

auditPlugin({ store: new SqlAuditStore() })
```

## Referência da API

### `auditPlugin(options?: AuditPluginOptions)`

Regista um `Audit` (singleton, token `AUDIT`), liga-se a **todos** os hooks (`hooks.onAny`) filtrando pelos padrões, e no `boot` subscreve o `EventBus` (se existir no contentor) para gravar eventos.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `AuditStore` | Não | `new MemoryAuditStore()` | Onde as entradas são guardadas. |
| `hooks` | `string[]` | Não | `['auth:**', 'billing:**', 'tenancy:**', 'permission:**']` | Padrões de hooks gravados automaticamente (substitui os defaults). |
| `events` | `string[]` | Não | `['**']` (tudo) | Padrões de eventos do EventBus gravados. `[]` desliga. |

### `class Audit`

| Método | Assinatura | Descrição |
|---|---|---|
| `constructor` | `new Audit(store: AuditStore)` | Cria a fachada sobre um store. |
| `record` | `(event: string, payload?: unknown) => Promise<AuditEntry>` | Entrada manual (`source: 'manual'`), enriquecida do contexto. Devolve a entrada. |
| `trail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | Consulta, mais recente primeiro. |
| `capture` | `(source: 'hook' \| 'event', event, payload) => Promise<void>` | **Avançado/interno**: usado pelas escutas do plugin. |

### `interface AuditEntry` (todos os campos `readonly`)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string` | UUID gerado no registo. |
| `source` | `'hook' \| 'event' \| 'manual'` | Origem da entrada. |
| `event` | `string` | Nome do hook/evento/ação. |
| `payload` | `unknown` | Dados associados. |
| `actorId` | `string \| undefined` | `ctx().user.id` no momento do registo. |
| `tenantId` | `string \| undefined` | `ctx().tenant.id` no momento do registo. |
| `requestId` | `string \| undefined` | `ctx().requestId`. |
| `at` | `number` | Timestamp (`Date.now()`, milissegundos). |

### `interface AuditQuery`

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `event` | `string` | Não | todos | Padrão wildcard sobre o nome (ex.: `'auth:**'`). |
| `tenantId` | `string` | Não | todos | Filtra por tenant. |
| `actorId` | `string` | Não | todos | Filtra por ator. |
| `since` | `number` | Não | desde sempre | Só entradas com `at >= since`. |
| `limit` | `number` | Não | sem limite | Máximo de resultados. |

### `interface AuditStore`

Contrato de armazenamento, **append-only por contrato** (sem update/delete):

- `append(entry: AuditEntry): Promise<void>`
- `query(query: AuditQuery): Promise<AuditEntry[]>` — deve devolver mais recente primeiro e aplicar os filtros/limit.

### `class MemoryAuditStore`

Implementação em memória do `AuditStore` (congela cada entrada; filtra e inverte na consulta). Ideal para dev e testes; não persiste.

### `patternMatches(pattern: string, name: string): boolean`

Matcher de wildcards sobre segmentos `:` e `.` — exportado para reutilização. `*` = um segmento; `**` = um ou mais; `'**'` casa tudo.

```ts
import { patternMatches } from '@machize/audit'

patternMatches('auth:**', 'auth:login')      // true
patternMatches('order.*', 'order.created')   // true
patternMatches('auth:**', 'billing:paid')    // false
```

### Token

- `AUDIT: Token<Audit>` — `app.container.get(AUDIT)`.

## Erros comuns e soluções (FAQ)

**As entradas têm `actorId`/`tenantId` vazios.**
Não havia contexto ativo no momento do registo. Garante que o código corre dentro de `runWithContext({ user, tenant }, …)` — em HTTP, é o middleware que o estabelece.

**Os eventos de domínio não estão a ser gravados.**
Ou o `eventsPlugin()` não está registado (o `auditPlugin` só subscreve o bus se `container.has(EVENTS)`), ou passaste `events: []`, ou os padrões não casam com os nomes dos eventos.

**Um hook meu não aparece no trilho.**
Os defaults só cobrem `auth/billing/tenancy/permission`. Passa `hooks: [...]` com os teus padrões — atenção que a lista **substitui** os defaults, por isso inclui também os que queres manter.

**Perdi o histórico depois de reiniciar.**
O `MemoryAuditStore` é volátil. Em produção implementa `AuditStore` sobre a base de dados.

**Posso editar ou apagar uma entrada?**
Não — o contrato é append-only e as entradas são congeladas. É uma característica, não uma limitação: é o que dá valor probatório ao trilho.

**Qual a diferença entre `:` e `.` nos nomes?**
Convenção: hooks de ciclo de vida usam `:` (`auth:login`); eventos de domínio usam `.` (`order.created`). O `patternMatches` trata ambos como separadores de segmentos.

## Como se liga aos outros módulos

- **`@machize/core`** — os hooks de ciclo de vida (`hooks.onAny`) são a primeira fonte de captura; o contexto ALS (`tryCtx`) fornece ator/tenant/requestId; o plugin usa `definePlugin`/`createToken`.
- **`@machize/events`** — segunda fonte de captura: qualquer evento de domínio emitido no `EventBus` pode ficar no trilho (padrões `events`).
- **`@machize/activity`** — módulo irmão com foco diferente: a **atividade** é o feed "human-friendly" para mostrar ao utilizador ("Maria publicou o projeto"); a **auditoria** é o registo de segurança/compliance automático e imutável.
- **`@machize/logger`** — os logs são diagnóstico técnico efémero; a auditoria é registo de negócio duradouro. Usa ambos.
- **`@machize/queue`** — como o contexto viaja para os workers, entradas registadas dentro de um job mantêm o ator/tenant do pedido original.
