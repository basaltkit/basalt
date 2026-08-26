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
seis** stores de auth — utilizadores, sessões, refresh tokens, tokens de uso único
(verify/reset), API keys e MFA — sobre o `node:sqlite` embutido do Node. Sem ORM, sem
ferramenta de migração, sem serviço separado, zero dependências externas.

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
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

`sqliteAuthStores()` abre (ou cria) o ficheiro, aplica um schema idempotente, e devolve
todos os stores nomeados para encaixarem diretamente nos plugins. O resto do teu código
de auth fica intacto — estas classes implementam os mesmos contratos que os stores em
memória. Cada store também é exportado por si só (`SqliteUserSource`, …) para que
possas misturar backends.

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
[`@basaltkit/auth-prisma`](/pt/reference/packages) dá-te os mesmos seis stores de auth
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

O backend SQLite mantém um índice parcial sobre as linhas não publicadas para que o
scan "o que está pendente?" do relay se mantenha barato. O backend Prisma coloca o
outbox na tua base de dados primária — o objetivo do padrão: enfileira o evento **na
mesma transação** que a mudança de estado, e os dois nunca podem discordar. `pending`,
os limites de tentativas e `markPublished`/`markFailed` mantêm as semânticas em
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
| Cache | `MemoryCacheDriver` | `RedisCacheDriver` (`@basaltkit/cache`), tiered (`@basaltkit/cache-tiered`) |
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
totalmente testadas para os seis stores de auth — lê qualquer uma quando construíres uma
para outra base de dados ou ORM. A mesma abordagem aplica-se a todos os outros contratos
de store na stack.

## O que fazer antes de ir para produção

- Substitui os stores de **auth** em memória por `@basaltkit/auth-sqlite` (ou a tua
  própria DB).
- Move **cache**, **usage metering** e **idempotência de webhook** para Redis se
  correres mais do que uma instância.
- Aponta **queues**, **search** e **storage** para os seus drivers de produção.

Vê [Going to Production](/pt/guide/production) para a checklist completa.
