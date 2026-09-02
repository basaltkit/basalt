# Persistence e stores duráveis

A maioria dos building blocks da Basalt mantém o seu estado por trás de um pequeno
**contrato de store** (uma interface), e traz uma **implementação em memória** como
predefinição. Isso é deliberado: podes construir e testar uma app inteira sem base de
dados a correr. Mas um store em memória perde tudo quando o processo termina — bom
para dev e CI, não para produção.

Ir para produção significa trocar os stores em memória por duráveis. O contrato
mantém-se idêntico, por isso é uma mudança de uma linha por store — sem reescrita.

[[toc]]

## O padrão

Toma a autenticação. `authPlugin` aceita um `UserSource`, um `SessionStore`, um
`RefreshTokenStore`, e mais. Não lhe dês nada e usa as predefinições em memória; dá-lhe
implementações duráveis e os teus utilizadores permanecem autenticados através de um
redeploy:

```ts
authPlugin({ secret })                       // dev — em memória, esquece no restart
authPlugin({ secret, users, sessions, ... }) // prod — stores duráveis
```

Cada store é apenas uma interface. Podes implementar uma contra qualquer base de dados
que já corras, ou recorrer a um pacote pronto a usar.

## Auth em SQLite — `@basaltkit/auth-sqlite`

O "backend real" de referência para auth é
[`@basaltkit/auth-sqlite`](/pt/reference/packages): implementações duráveis de **todos os
sete** stores de auth — utilizadores, sessões, refresh tokens, tokens de uso único
(verify/reset), API keys, inscrição MFA e versões de token — sobre o `node:sqlite`
embutido do Node. Sem ORM, sem ferramenta de migração, sem serviço separado, zero
dependências externas.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db')   // ':memory:' por predefinição

createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens,   // verificação de email + reset de password
      mfa: s.mfa,
      // tokenVersions: s.tokenVersions, // opcional: revogação imediata de access tokens
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

`sqliteAuthStores()` abre (ou cria) o ficheiro, aplica um schema idempotente, e devolve
todos os stores nomeados para encaixarem diretamente nos plugins — mais o handle `db`
em bruto. O resto do teu código de auth fica intacto: estas classes implementam os
mesmos contratos que os stores em memória. Cada store também é exportado por si só
(`SqliteUserSource`, …) para que possas misturar backends. O `tokenVersions` **não tem
predefinição em memória** — o auth só verifica versões de token quando lhe passas um
store, ao custo de uma leitura por pedido verificado.

::: tip Versão do Node
`node:sqlite` é estável e sem flags no **Node 24**; no Node 22.x corre com
`--experimental-sqlite`. Requer Node 22.5+.
:::

O SQLite é uma predefinição genuinamente de nível de produção para apps de nó único.
Corres múltiplas instâncias que têm de partilhar estado de sessão? Aponta
sessões/refresh tokens para o Redis e mantém os utilizadores na tua base de dados
primária — os contratos tornam isso uma escolha por store.

## Auth em Postgres/MySQL — `@basaltkit/auth-prisma`

Quando a tua app já corre numa base de dados real,
[`@basaltkit/auth-prisma`](/pt/reference/packages) dá-te os mesmos sete stores de auth
suportados por **Prisma**. Trazes um `PrismaClient` gerado cujo schema inclua os
modelos `Auth*` (o pacote traz um `schema.prisma` de referência); os stores só tocam
nesses delegates, por isso assentam sobre o teu cliente existente sem tomarem posse do
teu schema ou conexão.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma)   // passa o teu cliente diretamente, sem cast

createApp({
  plugins: [
    authPlugin({ secret, users: s.users, sessions: s.sessions,
                 refreshTokens: s.refreshTokens, tokens: s.tokens, mfa: s.mfa }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

Não copies os modelos à mão — corre **`basalt prisma:sync`**. Descobre todos os pacotes
`@basaltkit/*-prisma` instalados e funde os modelos de que precisam no teu
`prisma/schema.prisma` (interativo por predefinição; `--yes` adiciona-os todos,
`--only=auth,teams` restringe, `--push` aplica imediatamente):

```bash
pnpm basalt prisma:sync --push        # adiciona modelos em falta + cria as tabelas
```

É idempotente e nunca toca nos teus próprios modelos. E se ligares um store `*-prisma`
antes de os seus modelos existirem, o store agora falha rápido com uma mensagem clara
nomeando o modelo em falta e apontando-te para aqui — acabaram-se os crípticos
`reading 'create' of undefined`.

Caso contrário, copia os modelos de referência para o teu `schema.prisma`,
`prisma migrate`, e avança. Para **database-per-tenant** — cada domínio isolado na sua
própria base de dados ou schema sem filtragem de tenant por store — combina-o com
`@basaltkit/prisma` e encaminha os stores através do cliente do tenant ativo. Esse
setup ponta a ponta tem o seu próprio guia:
[Database-per-tenant](/pt/guide/database-per-tenant).

::: tip Qual deles?
`@basaltkit/auth-sqlite` para um nó único com zero dependências;
`@basaltkit/auth-prisma` quando já corres Postgres/MySQL ou precisas que múltiplas
instâncias partilhem uma base de dados. Ambos implementam os contratos de store
idênticos, por isso trocar é uma mudança de uma linha.
:::

## Teams — `@basaltkit/teams-sqlite` / `@basaltkit/teams-prisma`

`@basaltkit/teams` mantém memberships e convites por trás do mesmo tipo de contrato de
store, e traz os mesmos dois backends duráveis — para que as rosters de equipa e os
convites pendentes também sobrevivam a um restart:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'   // nó único, zero-dep
// import { prismaTeamsStores } from '@basaltkit/teams-prisma' // Postgres/MySQL

const t = sqliteTeamsStores('./data/teams.db')
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

`prismaTeamsStores(prisma)` é o equivalente Prisma drop-in (traz um cliente com os
modelos `Team*` do schema de referência incluído). O mesmo trade-off "qual deles?" que
o auth: SQLite para um nó único, Prisma quando já corres uma base de dados ou precisas
de a partilhar entre instâncias. Podem partilhar um handle com os stores de auth.

## Subscriptions — `@basaltkit/subscriptions-sqlite` / `@basaltkit/subscriptions-prisma`

O billing tem três stores — o registo de **subscription**, os contadores de **usage**,
e a idempotência de **webhook** — e ambos os backends duráveis implementam os três:

```ts
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'   // nó único
// import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma' // Postgres/MySQL

const s = sqliteSubscriptionsStores('./data/billing.db')
subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })
```

O `consume()` medido é **atómico** em ambos: o SQLite corre-o numa transação
`BEGIN IMMEDIATE` com uma guarda `RETURNING`; o Prisma usa um `updateMany` condicional
que o row lock da base de dados serializa. Por isso uma quota de plano nunca é
ultrapassada sob concorrência — a mesma garantia que o store Lua do Redis dá, agora sem
precisar de Redis. A idempotência de webhook sobrevive a restarts e a múltiplas
instâncias (uma reivindicação de id único), pelo que um evento reentregue é processado
uma vez.

::: tip Já em Redis?
`@basaltkit/subscriptions` ainda traz `RedisUsageStore` e `RedisWebhookStore` — usa-os
se o Redis já é o teu store partilhado. Os backends SQLite/Prisma adicionam o **registo
de subscription** durável (que não tinha backend não-memória) e permitem-te persistir
os três na tua base de dados primária.
:::

## Comments, audit, activity e notifications

Os stores de conteúdo e observabilidade seguem o mesmo padrão de dois backends — um
store cada, SQLite para um nó único e Prisma para uma base de dados partilhada:

| Domínio | Store | SQLite | Prisma |
| --- | --- | --- | --- |
| Comments | `CommentStore` | `sqliteCommentsStore()` | `prismaCommentsStore(prisma)` |
| Audit trail | `AuditStore` (append-only) | `sqliteAuditStore()` | `prismaAuditStore(prisma)` |
| Activity feed | `ActivityStore` | `sqliteActivityStore()` | `prismaActivityStore(prisma)` |
| Notificações in-app | `InAppStore` | `sqliteInAppStore()` | `prismaInAppStore(prisma)` |
| Permissions | `AccessStore` | `sqliteAccessStore()` | `prismaAccessStore(prisma)` |

```ts
import { auditPlugin } from '@basaltkit/audit'
import { sqliteAuditStore } from '@basaltkit/audit-sqlite'          // nó único
// import { prismaAuditStore } from '@basaltkit/audit-prisma'       // Postgres/MySQL

auditPlugin({ store: sqliteAuditStore('./data/audit.db').store })
```

Cada um retorna `{ store }` (o SQLite também expõe o `db` partilhado) nomeado para o
seu plugin: `commentsPlugin({ store })`, `auditPlugin({ store })`,
`activityPlugin({ store })`, `notificationsPlugin({ inApp: store })`. As queries mantêm
as semânticas em memória — mais recente primeiro, scope por tenant/destinatário, o
wildcard de evento do audit, filtragem de não lidos — agora duráveis. Payloads JSON
(`payload` do audit, `properties` da activity, `data` da notificação) são guardados
como texto e fazem a ida e volta sem alterações.

`@basaltkit/permissions` segue a mesma forma: `permissionsPlugin({ store })` recebe o
`AccessStore` durável (atribuições de papel e grants, com scope), pelo que o estado RBAC
também sobrevive a um restart. `@basaltkit/flags` não precisa de backend — as feature
flags são declaradas em código e avaliadas deterministicamente, sem nada para
persistir.

## Tenancy — `@basaltkit/tenancy-sqlite` / `@basaltkit/tenancy-prisma`

O registo de tenants é a fundação de uma app multi-tenant, mas `@basaltkit/tenancy`
traz apenas `MemoryTenantSource` por predefinição — cada tenant é esquecido no restart.
Ambos os backends duráveis implementam o mesmo contrato `TenantSource`, pelo que o
registo (e os domínios personalizados de cada tenant) passa a ser persistente:

```ts
import { tenancyPlugin, subdomainResolver } from '@basaltkit/tenancy'
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // nó único, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')
await tenants.save({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
```

Um tenant é um **registo aberto** (`{ id, ...anything }`), guardado como JSON para que
qualquer campo por tenant faça a ida e volta sem alterações; os domínios personalizados
são normalizados numa tabela indexada para que `findByDomain` (o domain resolver) seja
uma lookup por chave. Ambos adicionam métodos de escrita — `save` (upsert + substitui o
conjunto de domínios), `remove` — e impõem **domínios globalmente únicos**: reivindicar
um já detido por outro tenant é rejeitado, pelo que o encaminhamento permanece
inequívoco. `prismaTenantSource` traz um `schema.prisma` de referência apanhado pelo
`basalt prisma:sync`; o mesmo trade-off "qual deles?" que o auth — SQLite para um nó
único, Prisma quando já corres uma base de dados.

## Outbox de eventos — `@basaltkit/events-sqlite` / `@basaltkit/events-prisma`

O outbox transacional escreve cada domain event num store durável, depois um relay
entrega-o ao mundo exterior (webhooks, Kafka…) e marca-o como publicado — a entrega é
**pelo menos uma vez e sobrevive a um crash**. Essa garantia só se mantém se o store for
durável, mas `@basaltkit/events` usa por predefinição `MemoryOutboxStore`, que perde
cada evento não relayado no restart. Ambos os backends implementam o mesmo contrato
`OutboxStore`:

```ts
import { outboxPlugin } from '@basaltkit/events'
import { sqliteOutboxStore } from '@basaltkit/events-sqlite'   // nó único, zero-dep
// import { prismaOutboxStore } from '@basaltkit/events-prisma' // Postgres/MySQL

const outbox = sqliteOutboxStore('./data/outbox.db')
outboxPlugin({
  store: outbox.store,
  captureEvents: ['order.*', 'invoice.*'], // registados duravelmente à medida que disparam
  dispatch: async (entry) => sendToWebhook(entry),
  intervalMs: 1000,
})
```

### Semântica do relay

O relay é a parte que decide se o "pelo menos uma vez" é real. Quatro
comportamentos, todos verificáveis em `@basaltkit/events`:

- **A captura é aguardada.** Um padrão em `captureEvents` subscreve no bus do
  `@basaltkit/events`, e o listener faz `await` da escrita no outbox. Se essa
  escrita falhar, o `emit()` falha (o bus agrega as falhas dos listeners num
  `AggregateError`) em vez de o evento ser descartado silenciosamente enquanto o
  outbox promete at-least-once. O tenant é lido do contexto ambiente
  (`ctx().tenant.id`), por isso uma entrada registada dentro de um pedido fica
  automaticamente delimitada por tenant.
- **Ticks sobrepostos coalescem.** O `flush()` devolve o flush em curso em vez de
  voltar a selecionar o batch, por isso um dispatch mais lento que `intervalMs`
  não consegue entregar em duplicado as suas próprias entradas.
- **As falhas recuam.** Uma entrada falhada é ignorada por este processo até o seu
  atraso decorrer: `delayMs · 2^(tentativas-1)`, limitado a `maxDelayMs`
  (`type: 'fixed'` mantém-no constante, `backoff: false` faz retry em cada tick).
  O calendário é **local ao processo** — sem alteração de schema, e um restart
  esquece-o, pelo que o pior caso é um retry antecipado. Continua at-least-once.
- **As entradas mortas são ruidosas.** Uma entrada que atinge `maxAttempts` é
  excluída dos futuros scans de `pending()` e reportada uma vez através de
  `onDead(entry, error)`; fica no store com o seu `lastError` para inspeção. Nada
  a apaga por ti.

::: warning Dois callbacks de erro diferentes
O `onDead(entry, error)` dispara para **uma entrada** que esgotou as suas tentativas.
O `onFlushError(error)` dispara quando o **próprio flush** falhou ao nível do store —
o `pending()` lançou, a base de dados está inacessível — pelo que nenhuma entrada
chegou sequer a ser selecionada. As falhas de dispatch por entrada nunca chegam ao
`onFlushError`; são registadas na entrada via `markFailed`. Ambos usam por
predefinição `console.error`
(`[basalt:outbox] entry "…" is dead after N attempts:` e
`[basalt:outbox] flush failed:`) e nenhum pode lançar. Tanto o caminho do
temporizador como a drenagem no encerramento passam pelo `onFlushError`, que é o que
impede uma falha da base de dados de se tornar uma rejeição não tratada que mata o
processo.
:::

```ts
outboxPlugin({
  store: outbox.store,
  dispatch: (entry) => sendToWebhook(entry),
  captureEvents: ['order.*', 'invoice.*'],
  intervalMs: 1000,
  batchSize: 50,
  maxAttempts: 10,
  backoff: { type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 },
  onDead: (entry, error) => alerts.page('outbox entry dead', { id: entry.id, event: entry.event, error }),
  onFlushError: (error) => logger.error({ err: error }, 'outbox flush failed'),
})
```

`outboxPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `dispatch` | `(entry: OutboxEntry) => void \| Promise<void>` | — (**obrigatório**) | Entrega uma entrada confirmada ao mundo exterior; lançar marca a entrada como falhada e agenda um retry |
| `store` | `OutboxStore` | `new MemoryOutboxStore()` | Onde vivem as entradas — toda a garantia depende de este ser durável |
| `captureEvents` | `string[]` | `[]` | Padrões de evento registados automaticamente (`'order.*'`); uma lista não vazia faz o plugin depender de `basalt:events` |
| `intervalMs` | `number` | — (manual) | Intervalo de polling do relay. Omite para fazeres flush tu via o token `OUTBOX`; o temporizador tem `unref()` por isso nunca mantém o processo vivo |
| `batchSize` | `number` | `50` | Entradas selecionadas por flush — sobe para throughput, desce para limitar o trabalho de um tick |
| `maxAttempts` | `number` | `10` | Tentativas antes de uma entrada ficar morta e ser reportada ao `onDead` |
| `backoff` | `OutboxBackoff \| false` | `{ type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 }` | Ritmo de retry para entradas falhadas; `false` faz retry em cada tick |
| `onDead` | `(entry, error) => void` | `console.error` | Uma entrada esgotou `maxAttempts` — chama alguém, isto é uma entrega externa perdida |
| `onFlushError` | `(error) => void` | `console.error` | O flush falhou ao nível do store (tick do temporizador ou drenagem no encerramento). Nunca pode lançar |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |

`backoff` (`OutboxBackoff`):

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `delayMs` | `number` | `1000` | Atraso base antes de repetir uma entrada falhada |
| `type` | `'fixed' \| 'exponential'` | `'exponential'` | Espaçamento dos retries: a duplicar ou constante |
| `maxDelayMs` | `number` | `60_000` | Teto para o atraso exponencial |

O backend SQLite mantém um índice parcial sobre as linhas não publicadas para que o
scan "o que está pendente?" do relay se mantenha barato. O backend Prisma coloca o
outbox na tua base de dados primária — o objetivo do padrão: enfileira o evento **na
mesma transação** que a mudança de estado, e os dois nunca podem discordar. `pending`,
os limites de tentativas e `markPublished`/`markFailed` mantêm as semânticas em
memória, agora duráveis.

memória, agora duráveis.

## Webhooks de saída — `@basaltkit/webhooks-sqlite` / `@basaltkit/webhooks-prisma`

`@basaltkit/webhooks` mantém as suas subscrições de endpoint por trás de um
`WebhookStore`, e usa por predefinição `MemoryWebhookStore` — pelo que um redeploy
esquece cada endpoint registado e os eventos deixam silenciosamente de ser entregues.
Ambos os backends duráveis persistem as subscrições:

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'   // nó único, zero-dep
// import { prismaWebhookStore } from '@basaltkit/webhooks-prisma' // Postgres/MySQL

const webhooks = sqliteWebhookStore('./data/webhooks.db')
webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Cada endpoint (URL, padrões de evento, tenant opcional, secret por endpoint e flag
`active`) sobrevive a um restart. A correspondência de padrão de evento (`*`,
`prefix.*`, exato) reutiliza `matchesEvent`, pelo que `forEvent` se comporta de forma
idêntica ao store de memória — a lógica de entrega/retry é inalterada, apenas a lista de
subscrições é agora durável.

## Stores suportados por Redis

Vários pacotes já trazem implementações Redis para o estado que mais beneficia de ser
partilhado entre instâncias:

| Preocupação | Em memória (predefinição) | Durável / partilhado |
| --- | --- | --- |
| Cache | `MemoryCacheDriver` | `redisCache()` (`@basaltkit/cache-redis`), tiered (`@basaltkit/cache-tiered`) |
| Usage metering | `MemoryUsageStore` | `RedisUsageStore` — `consume()` atómico via Lua |
| Idempotência de webhook | `MemoryWebhookStore` | `RedisWebhookStore` — `SET NX EX` entre restarts |
| Rate limiting | `MemoryRateLimitStore` | `RedisRateLimitStore` (`@basaltkit/http`) — um contador atómico partilhado entre instâncias |
| Idempotência de request | `MemoryIdempotencyStore` | `RedisIdempotencyStore` (`@basaltkit/fastify`) — reproduz uma resposta em cache entre instâncias |
| Queues | driver em memória | pacotes de driver RabbitMQ / Kafka / SQS |
| Search | `MemorySearchDriver` | pacotes de driver Meilisearch / Postgres |
| Storage | disco local | pacotes de driver S3 / GCS / Azure |

## Escrever o teu próprio store

Um store é um punhado de métodos async. Para suportar utilizadores de auth com a tua
base de dados existente, implementa `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch } from '@basaltkit/auth'

class PrismaUserSource implements UserSource {
  async findByEmail(email: string): Promise<AuthUser | null> { /* … */ }
  async findById(id: string): Promise<AuthUser | null> { /* … */ }
  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> { /* … */ }
  async update(id: string, patch: UserPatch): Promise<AuthUser | null> { /* … */ }
}
```

`@basaltkit/auth-sqlite` e `@basaltkit/auth-prisma` são referências compactas e
totalmente testadas para os sete stores de auth — lê qualquer uma quando construíres uma
para outra base de dados ou ORM. A mesma abordagem aplica-se a todos os outros contratos
de store na stack.

## Referência de opções

Cada backend durável é uma **factory**, não um plugin — chama-la uma vez no
arranque e passas o resultado ao plugin dono do domínio. As duas famílias têm uma
assinatura cada:

| Família | Assinatura | Devolve |
| --- | --- | --- |
| `sqlite*` | `(dbOrLocation: DatabaseSync \| string = ':memory:')` | `{ db, …stores }` — o handle `node:sqlite` em bruto mais um store por contrato |
| `prisma*` | `(client: PrismaClient)` | `{ …stores }` — sem handle; o cliente já é teu |

Passar um **caminho** abre (ou cria) o ficheiro e aplica o schema; passar um
`DatabaseSync` existente migra esse handle, que é como vários domínios partilham
um só ficheiro. `':memory:'` é a predefinição, e é por isso que uma factory sem
configuração continua segura em testes.

| Domínio | Factory SQLite | Factory Prisma | Alimenta |
| --- | --- | --- | --- |
| Auth | `sqliteAuthStores()` | `prismaAuthStores(client)` | `authPlugin({ users, sessions, refreshTokens, tokens, mfa, tokenVersions })`, `apiKeysPlugin({ store, users })` |
| Teams | `sqliteTeamsStores()` | `prismaTeamsStores(client)` | `teamsPlugin({ memberships, invitations })` |
| Subscriptions | `sqliteSubscriptionsStores()` | `prismaSubscriptionsStores(client)` | `subscriptionsPlugin({ store, usage, webhooks })` |
| Pagamentos | `sqlitePaymentStores()` | `prismaPaymentStores(client)` | os stores do ledger de pagamentos + recorrências |
| Comments | `sqliteCommentsStore()` | `prismaCommentsStore(client)` | `commentsPlugin({ store })` |
| Audit | `sqliteAuditStore()` | `prismaAuditStore(client)` | `auditPlugin({ store })` |
| Activity | `sqliteActivityStore()` | `prismaActivityStore(client)` | `activityPlugin({ store })` |
| Notifications | `sqliteInAppStore()` | `prismaInAppStore(client)` | `notificationsPlugin({ inApp: store })` |
| Permissions | `sqliteAccessStore()` | `prismaAccessStore(client)` | `permissionsPlugin({ store })` |
| Tenancy | `sqliteTenantSource()` | `prismaTenantSource(client)` | `tenancyPlugin({ source })` — devolve a própria source, não `{ store }` |
| Outbox de eventos | `sqliteOutboxStore()` | `prismaOutboxStore(client)` | `outboxPlugin({ store })` |
| Webhooks | `sqliteWebhookStore()` | `prismaWebhookStore(client)` | `webhooksPlugin({ store })` |

Cada pacote também exporta `openXDatabase(location)` e `migrate(db)` se quiseres
controlar tu a abertura e a migração, e cada classe de store individual
(`SqliteUserSource`, `PrismaAuditStore`, …) recebe um `DatabaseSync` /
`PrismaClient` no construtor — por isso podes misturar backends por store.

O único backend com opções de comportamento próprias é o relay do outbox; as suas
tabelas estão em **Semântica do relay**, acima. Todo o resto é configurado no
plugin que o consome — vê [Auth](/pt/guide/auth), [Teams](/pt/guide/teams),
[Billing](/pt/guide/billing), [Tenancy](/pt/guide/tenancy) e
[Webhooks](/pt/guide/webhooks).

## Modos de falha e resolução de problemas

| Erro | Código | Quando |
| --- | --- | --- |
| `Error: @basaltkit/<pkg>-prisma: the Prisma client has no <model> model.` | — | Uma factory `prisma*` correu contra um cliente cujo schema não tem os modelos. Corre `basalt prisma:sync --push` e depois `prisma generate`. Clientes lazy/proxy (base de dados por tenant) saltam a verificação e falham na primeira utilização |
| `Error: @basaltkit/tenancy-prisma: domain "…" is already owned by tenant "…".` | — | O `save()` tentou reivindicar um domínio personalizado que pertence a outro tenant. Os domínios são globalmente únicos para o encaminhamento ser inequívoco; o save inteiro é rejeitado antes de qualquer escrita. A source SQLite impõe a mesma regra com uma constraint PRIMARY KEY, dentro de uma transação que faz rollback |
| `AggregateError` vindo de `bus.emit(...)` | — | Uma escrita de captura do outbox falhou. A captura é aguardada de propósito — o emissor tem de ver a falha em vez de acreditar que um evento perdido foi registado |
| `EventValidationError` | `EVENT_INVALID` | O schema do evento rejeitou o payload antes de qualquer listener (incluindo a captura do outbox) correr |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | O `OUTBOX` (ou qualquer token de store) foi resolvido sem o plugin que o regista |
| `ERR_UNKNOWN_BUILTIN_MODULE` no `import 'node:sqlite'` | — | Um pacote `*-sqlite` em Node 22.x sem `--experimental-sqlite`. Usa Node 24, ou acrescenta a flag; os pacotes declaram `engines.node >= 22.5.0` |

- **"Funcionava em dev e esqueceu tudo depois do deploy"** — um store continua na
  sua predefinição em memória. As predefinições são silenciosas por design; procura
  no teu `createApp` os plugins a que nunca passaste um store, e percorre a
  checklist abaixo.
- **As entradas do outbox acumulam-se por publicar** — ou não há relay a correr
  (`intervalMs` por definir e nada chama `OUTBOX.flush()`), ou todas as entradas
  estão mortas. As entradas mortas são excluídas do `pending()`, por isso a tabela
  cresce enquanto o relay diz não ter nada a fazer: verifica o `lastError` e se o
  `onDead` disparou.
- **Os eventos são registados mas nunca entregues depois de um redeploy** — o
  store do outbox é durável mas as **subscrições de webhook** não são. O
  `MemoryWebhookStore` esquece cada endpoint registado, e a entrega para em
  silêncio.
- **`SQLITE_BUSY` / contenção de locks sob carga** — um ficheiro SQLite é um só
  escritor. É esse o trade-off das zero dependências; move o domínio quente para
  Prisma (ou Redis, no caso de cache/usage/idempotência) quando um único escritor
  deixar de chegar.
- **Um store durável continua a não devolver nada para um tenant** — o store é
  durável, não encaminhado por tenant. Para base de dados por tenant tens de o
  encaminhar através do cliente do tenant ativo; vê
  [Base de dados por tenant](/pt/guide/database-per-tenant).

## O que fazer antes de ir para produção

- Substitui os stores de **auth** em memória por `@basaltkit/auth-sqlite` (ou a tua
  própria DB).
- Move **cache**, **usage metering** e **idempotência de webhook** para Redis se
  correres mais do que uma instância.
- Aponta **queues**, **search** e **storage** para os seus drivers de produção.

Vê [Going to Production](/pt/guide/production) para a checklist completa.
