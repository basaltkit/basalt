# Ir para Produção

Uma checklist para pôr uma app Basalt em produção, e onde vive cada capacidade.
A maior parte está ligada por predefinição — esta página é sobre fazer as
escolhas deliberadas, e sobre o punhado de coisas que só mordem em produção. Cada
linha liga ao guia que traz a tabela de opções completa; nada aqui repete uma.

[[toc]]

## Checklist

- [ ] **Segredos são fail-closed** — assina com `secret()` para que a produção
      recuse placeholders. Ver [Segurança](/pt/guide/security#segredos-fail-closed-—-secret).
- [ ] **A borda está protegida** — `securityPlugin({ rateLimit, cors, headers })`. O limite
      global é chaveado só pelo endereço; uma API pública para clientes máquina
      recebe `rateLimit.prefixes` e orçamentos por chave. Vê [Rate limiting](/pt/guide/security#rate-limiting).
- [ ] **Logins são limitados** — ligado por predefinição em `@basaltkit/auth`.
- [ ] **Mutações são idempotentes** — `idempotencyPlugin()` para `POST` (associa as chaves ao pedido e repete só depois dos guards, por omissão).
- [ ] **A app arranca a frio com a configuração de produção** — as guardas de boot
      abaixo só disparam quando chamas mesmo `boot()`.
- [ ] **Sondas de saúde ligadas** — `healthPlugin({ checks })` para `/livez` + `/readyz`.
- [ ] **Métricas recolhidas** — `metricsPlugin()` em `/metrics`, e nem ele nem o
      `/readyz` estão acessíveis a partir da internet.
- [ ] **Tracing exportado** — `tracingPlugin({ exporter })` (OTLP), com o
      `serviceName` definido também no **exporter**.
- [ ] **Nada de importante escreve para `console.error`** — aponta os callbacks de
      erro assíncronos para o teu logger: `onBridgeError` / `onDeliveryError` do
      realtime, `onDead` / `onFlushError` do outbox, `onError` / `onJobFailed` dos
      drivers de fila. Todos usam a consola por predefinição, que a maioria das
      plataformas descarta. Ver [Observabilidade](/pt/guide/observability).
- [ ] **API documentada** — `openapiPlugin({ info })`.
- [ ] **Entrega externa é fiável** — `outboxPlugin` / `webhooksPlugin`.
- [ ] **O trabalho agendado corre uma vez, não uma vez por réplica** —
      `.onOneServer()` com um `ScheduleLock` partilhado. Ver
      [Scheduler](/pt/guide/scheduler).
- [ ] **Base de dados real** — põe os dados do teu domínio em `@basaltkit/prisma`, e
      troca os stores em memória do framework (auth, teams, subscriptions, permissions,
      comments, audit, activity, notifications) pelos seus backends duráveis
      [`*-sqlite` / `*-prisma`](/pt/guide/persistence).
- [ ] **Migrações correm por tenant** — `migrateTenants()` / comando `basalt`.
- [ ] **Compilada, não transpilada em runtime** — `pnpm build` + `node dist/src/server.js`
      (ou o `Dockerfile` do scaffold); nada de tsx em produção. Ver [Build e envio](#build-e-envio).
- [ ] **CI verde** — build, typecheck, gate de cobertura, `pnpm audit`, CodeQL.
- [ ] **Um único caminho de deploy** — num único servidor Linux, o `@basaltkit/deploy`
      trata do `.env`, da infraestrutura, do build, de um dump antes da migração,
      da migração, do reinício, de um health check e do rollback. Vê
      [Deploy para um servidor](/pt/guide/deploy).

## Um `buildApp` com forma de produção

```ts
import { createApp } from '@basaltkit/core'
import {
  fastifyPlugin, securityPlugin, healthPlugin, metricsPlugin,
  openapiPlugin, idempotencyPlugin,
} from '@basaltkit/fastify'
import { prismaPlugin } from '@basaltkit/prisma'
import { env } from './env.js'

export function buildApp() {
  return createApp({
    plugins: [
      // ...tenancy, auth, subscriptions, os teus plugins de domínio...
      prismaPlugin({ forTenant: (id) => clientFor(id) }), // base de dados por tenant
      securityPlugin({
        rateLimit: { limit: 300, windowMs: 60_000 },
        cors: { origin: env.WEB_ORIGIN.split(','), credentials: true },
        headers: true,
      }),
      idempotencyPlugin(),
      healthPlugin({ checks: { db: () => ({ ok: pool.isHealthy() }) } }),
      metricsPlugin(),
      openapiPlugin({ info: { title: 'My API', version: '1.0.0' } }),
      fastifyPlugin({ routes, fastify: { bodyLimit: 1_048_576, trustProxy: true } }),
    ],
  })
}
```

::: tip Limites de pedido
Passa opções do servidor Fastify através de `fastifyPlugin({ fastify })`: `bodyLimit`
(tamanho máximo do pedido), `requestTimeout`, e `trustProxy` (para que o rate
limiting e o logging vejam o IP real do cliente por detrás de um load balancer).
:::

## O que falha ruidosamente no boot

Duas classes de má configuração são apanhadas pelo `boot()` em vez de descobertas
em produção. Ambas lançam, por isso um deploy mau morre no arranque em vez de
servir tráfego — o que só é útil se a tua pipeline arrancar mesmo a app (um smoke
test, ou o primeiro contentor a falhar a sua sonda de readiness).

| Erro | Código | Significa |
| --- | --- | --- |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | Uma rota declara uma chave de segurança guardada (`meta.auth`, `can`, `teamRole`, `scopes`, `subscribed`, `feature`) e **nenhum plugin registado impõe essa chave** — teria servido sem proteção. Regista o plugin que a impõe (`authPlugin`, `permissionsPlugin`, `teamsPlugin`, `apiKeysPlugin`, `subscriptionsPlugin`), ou, se a verificação acontece mesmo numa borda exterior, opta explicitamente por fora com a opção `allowUnguardedMeta: true` do adaptador (ou uma lista de chaves) |
| `CaptiveDependencyError` | `DI_CAPTIVE_DEPENDENCY` | Um token `scoped` foi resolvido dentro da factory de um **singleton**. O singleton sobrevive a cada scope, por isso serviria a instância por pedido do pedido 1 a todos os pedidos seguintes. Resolve o serviço scoped no momento de uso (`ctx().container`) em vez de na construção |

A verificação de meta sem guarda é a razão por que declarar `meta.can` e esquecer
o `permissionsPlugin` é uma falha de deploy e não um buraco silencioso de
autorização. Cobre exatamente as chaves em `GUARDED_META_KEYS`; um valor
`false`/`undefined` numa rota é uma desativação explícita e nunca é assinalado. Ver
[Autorização](/pt/guide/authorization) e [Adaptadores](/pt/guide/adapters).

Com `prismaPlugin({ assertMigrated: true })` o boot recusa também uma base
inacessível, por migrar, ou que o role da app não pode usar — e diz qual, com a
correcção (um `GRANT` em falta, um baseline, `migrate deploy`). Os significados,
um `db:status` só de leitura para a CI e uma receita pós-deploy idempotente para
grants e extensões estão em [Operações de base de dados](/pt/guide/database-operations).

## Persistência

O desenvolvimento corre sobre stores em memória, por isso não há nada a instalar.
Em produção, `@basaltkit/prisma` oferece três estratégias de tenancy — o código de
domínio (`db().model.findMany()`) é idêntico nas três:

| Estratégia | Ativar com |
| --- | --- |
| Base de dados partilhada (nível de linha) | `prismaPlugin({ client: new PrismaClient({ adapter }).$extends(tenancyExtension()) })` |
| Base de dados por tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlFor(id) }) }) })` |
| Schema por tenant | `prismaPlugin({ schemaPerTenant: { url, createClient } })` |

Um `TenantClientPool` integrado mantém a contagem de ligações limitada (nunca acima
de `max`, e nunca despeja um cliente ainda em uso — dimensiona `max` para os tenants
activos ao mesmo tempo, ou tenants novos recebem um 503 `TenantPoolExhaustedError`), e
`migrateTenants()` corre migrações em todos os tenants. Gera um recurso apoiado
em Prisma com `basalt make:resource Invoice --prisma`.

**Falha cedo na base de dados errada.** `prismaPlugin({ client, assertMigrated: true })`
verifica no arranque que `_prisma_migrations` existe (`{ tables: [...] }` verifica
também essas tabelas) e recusa arrancar caso contrário, indicando a base de dados
e o host a que chegou — nunca as credenciais (`PRISMA_NOT_MIGRATED`). Apanha uma
shell que exportou o `DATABASE_URL` de outro projeto no arranque, em vez de um
P2021 no primeiro pedido. `{ forbiddenTables: [...] }` faz a verificação
oposta — tabelas que **não** podem lá estar, como tabelas de tenant recriadas na
base central — e recusa com `PRISMA_PLANE_MIXED`
([proteger contra o plano errado](/pt/guide/multi-tenant-pattern#proteger-contra-o-plano-errado)).
Desligado por omissão.

`@basaltkit/prisma` é para os dados de domínio **teus**. Os próprios domínios com
estado do framework — auth, teams, subscriptions, permissions, comments, audit,
activity e notifications — também são por omissão em memória e cada um tem um
backend durável para trocar: `@basaltkit/<domain>-sqlite` (single-node,
`node:sqlite`, zero dependências) ou `@basaltkit/<domain>-prisma` (Postgres/MySQL).
É uma alteração de uma linha por store porque o contrato não muda. Ver o
[guia de Persistência](/pt/guide/persistence) para o catálogo, e
[Base de dados por tenant](/pt/guide/database-per-tenant) para encaminhar esses
stores através do cliente do tenant ativo.

## Escalar leituras (read replicas)

Quando uma base de dados já não aguenta a carga de leitura, acrescenta réplicas de
leitura e divide o tráfego: as leituras vão para as réplicas, as escritas ficam no
primary. O `readReplica` embrulha os teus clientes Prisma e faz o encaminhamento. É
um `Proxy`, não uma dependência.

### O que é uma réplica

Uma réplica de leitura é uma **cópia da base de dados primary**, mantida em dia por
replicação: streaming replication do PostgreSQL, ou a «read replica» do teu
fornecedor (RDS, Neon, Supabase e outros). Tem os mesmos dados e recusa escritas.

::: danger Uma réplica nunca é outra base de dados
Apontar o URL de uma «réplica» para outra base de dados (outro nome no mesmo
servidor, uma cópia de staging) não falha no arranque. Em vez disso, divide os
teus dados: uma linha escrita no primary «não existe» na leitura seguinte, que vai
para a outra base de dados.
:::

### 1. Declara os URLs em `src/env.ts`

Uma lista opcional, para o mesmo código correr sem réplica (desenvolvimento, um só
servidor) e com várias:

```ts
// src/env.ts — dentro de defineEnv({ … })
DATABASE_URL: z.string().url(),
// Réplicas de leitura do DATABASE_URL, separadas por vírgulas. Vazio: tudo usa o primary.
DATABASE_REPLICA_URLS: z
  .string()
  .default('')
  .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean))
  .pipe(z.array(z.string().url())),
```

```sh
# .env
DATABASE_URL=postgres://…@db-primary:5432/app
DATABASE_REPLICA_URLS=postgres://…@db-replica-1:5432/app,postgres://…@db-replica-2:5432/app
```

### 2. Liga o cliente

```ts
// src/app.ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { prismaPlugin, readReplica } from '@basaltkit/prisma'
import { env } from './env.js'

// O Prisma 7 liga-se através de um driver adapter: um cliente por connection string.
const pg = (connectionString: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

export const client = readReplica({
  primary: pg(env.DATABASE_URL),
  replicas: env.DATABASE_REPLICA_URLS.map(pg),
  // Multi-tenant? Aplica a MESMA extensão ao primary e a cada réplica:
  // extend: (c) => c.$extends(tenancyExtension()),
})

// em createApp({ plugins: [ … ] }):
prismaPlugin({ client })
```

Sem nenhum URL de réplica, o `readReplica` devolve o primary inalterado, mais o
`$primary`.

### 3. Usa-o dentro de um pedido

O `db()` devolve o cliente do **pedido atual**. Chama-o dentro do handler, nunca no
topo de um módulo: no carregamento não há pedido, e a app não arranca
(`DbUnavailableError`).

```ts
import { db } from '@basaltkit/prisma'
import type { client } from '../app.js'

route({
  method: 'POST',
  url: '/orders',
  handler: async ({ body }) => {
    const prisma = db<typeof client>()                       // aqui, não no topo do módulo
    const order = await prisma.order.create({ data: body })  // escrita → primary
    // Logo a seguir a escrever, uma réplica pode estar atrasada: lê do primary.
    return prisma.$primary.order.findUnique({ where: { id: order.id } })
  },
})
```

### O que vai para onde

| Chamada | Vai para |
|---|---|
| `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`, `count`, `aggregate`, `groupBy` | uma réplica, em round-robin |
| `create`, `update`, `upsert`, `delete` e as outras escritas | o primary |
| `$transaction`, `$executeRaw`, `$executeRawUnsafe` | o primary |
| `$queryRaw`, `$queryRawUnsafe` | o primary, a menos que passes `rawReadsOnReplica: true` |
| tudo o que passa por `$primary` | o primary |

As queries raw ficam no primary por omissão, por duas razões: SQL raw pode
escrever (um `WITH … INSERT`), e uma leitura que decide acessos (uma permissão, uma
sessão) não pode ler dados atrasados. Ativa `rawReadsOnReplica: true` só quando
todas as queries raw da app forem só de leitura e tolerarem atraso. Se uma extensão
acrescentar métodos de modelo que só leem, lista-os em `readOps: ['…']`.

**Multi-tenant:** uma réplica crua, sem a extensão, encaminharia as leituras à
volta do teu filtro de tenant e mostraria linhas de outros tenants. Passa o
`extend`, como acima, para o primary e cada réplica terem o mesmo
`tenancyExtension()`.

### Experimentar localmente

Este compose corre um primary PostgreSQL e uma réplica por streaming, clonada com
`pg_basebackup`. É só para desenvolvimento: as passwords são fixas e não há TLS.

::: details `docker/compose.replica.yml` e os seus dois scripts
```yaml
# docker/compose.replica.yml
name: app-replica
services:
  primary:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: app }
    command: [postgres, -c, wal_level=replica, -c, max_wal_senders=5, -c, hot_standby=on]
    ports: ["127.0.0.1:55460:5432"]
    volumes:
      - primary-data:/var/lib/postgresql/data
      - ./replica/init-primary.sh:/docker-entrypoint-initdb.d/10-replication.sh:ro
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres -d app"], interval: 2s, retries: 30 }
  replica:
    image: postgres:16-alpine
    depends_on: { primary: { condition: service_healthy } }
    environment:
      PGDATA: /var/lib/postgresql/data
      PRIMARY_HOST: primary
      REPLICATION_USER: replicator
      REPLICATION_PASSWORD: replicator
    entrypoint: ["/bin/sh", "/replica/start-replica.sh"]
    ports: ["127.0.0.1:55461:5432"]
    volumes:
      - replica-data:/var/lib/postgresql/data
      - ./replica/start-replica.sh:/replica/start-replica.sh:ro
volumes: { primary-data: {}, replica-data: {} }
```

```sh
#!/bin/sh
# docker/replica/init-primary.sh — corre uma vez, quando o primary é criado
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
```

```sh
#!/bin/sh
# docker/replica/start-replica.sh — clona o primary no primeiro arranque, depois corre só de leitura
set -eu
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
  su-exec postgres env PGPASSWORD="$REPLICATION_PASSWORD" \
    pg_basebackup -h "$PRIMARY_HOST" -U "$REPLICATION_USER" -D "$PGDATA" -R -X stream -P
fi
exec su-exec postgres postgres -c hot_standby=on
```
:::

```sh
chmod +x docker/replica/*.sh   # sem isto o primary termina: "bad interpreter: Permission denied"
docker compose -f docker/compose.replica.yml up -d
# .env
DATABASE_URL=postgres://postgres:postgres@localhost:55460/app
DATABASE_REPLICA_URLS=postgres://postgres:postgres@localhost:55461/app
```

Cria as tabelas **só no primary** (`prisma migrate deploy` com o `DATABASE_URL`). A
réplica recebe-as pela replicação. Confirma que a replicação está a correr:

```sh
docker compose -f docker/compose.replica.yml exec primary \
  psql -U postgres -d app -c "SELECT client_addr, state FROM pg_stat_replication"   # state: streaming
docker compose -f docker/compose.replica.yml exec replica \
  psql -U postgres -d app -c "SELECT pg_is_in_recovery()"                           # t: só de leitura
```

O `docker compose -f docker/compose.replica.yml down -v` para os dois e apaga os
dados.

### Confirmar o encaminhamento

Pausa por um momento o replay na réplica: uma escrita que a app acabou de fazer
fica visível pelo `$primary`, mas não numa leitura normal. Isso prova que as
leituras vão para a réplica:

```ts
// scripts/replica-check.ts — corre com `pnpm tsx scripts/replica-check.ts`
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { client } from '../src/app.js'

const replica = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_REPLICA_URLS!.split(',')[0]! }) })
const id = `replica-check-${Date.now()}`
try {
  await replica.$queryRawUnsafe('SELECT pg_wal_replay_pause()::text')
  await client.order.create({ data: { id /* … */ } })                            // primary
  console.log('leitura normal:', await client.order.findUnique({ where: { id } }))  // null: a réplica está pausada
  console.log('$primary:', await client.$primary.order.findUnique({ where: { id } }))  // a linha
} finally {
  await replica.$queryRawUnsafe('SELECT pg_wal_replay_resume()::text')
  await client.$primary.order.deleteMany({ where: { id } })
  await replica.$disconnect()
  await client.$primary.$disconnect()
}
```

Uma escrita enviada diretamente à réplica falha com
`cannot execute INSERT in a read-only transaction`.

O TLS, os limites de ligações e o failover são do teu fornecedor de base de dados.
O Basalt só encaminha as chamadas.

## Fazer sharding da base de dados

As réplicas escalam leituras; o **sharding escala escritas e armazenamento**,
espalhando os tenants por várias bases de dados. O `ShardRouter` mapeia um id de
tenant para um shard com um hash estável — os dados de um tenant caem sempre na
mesma base:

```ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { prismaPlugin, ShardRouter } from '@basaltkit/prisma'

const shards = new ShardRouter({
  shards: [
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_0_URL }) }),
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_1_URL }) }),
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_2_URL }) }),
  ],
})

app.use(prismaPlugin({ shards }))
// o tenant de cada pedido é encaminhado para o seu shard; db() lê o correto
```

Os clients de shard são **longevos e partilhados** por todos os tenants que lhes
fazem hash (ao contrário do pool per-tenant, nada é despejado). Para trabalho
cross-shard — uma migração, um relatório global — faz fan-out sobre `shards.all()`:

```ts
await Promise.all(shards.all().map((db) => db.$executeRawUnsafe(migrationSql)))
```

O sharding é para **scale-out**, não isolamento — para uma-base-por-tenant usa
antes `prismaPlugin({ forTenant })`. Mudar `shards.length` re-mapeia as chaves,
por isso planeia uma migração antes de redimensionar; passa um `hash` próprio se
precisares de consistent hashing para minimizar o reshuffle.

## Build e envio

Uma app create-basalt corre em **node puro** em produção — o tsx é uma
devDependency e nunca é enviado. Três scripts tratam disso:

```bash
pnpm build       # tsc -p tsconfig.build.json → dist/ (só o src/; rootDir ".")
pnpm start       # node --enable-source-maps dist/src/server.js
pnpm start:dev   # tsx src/server.ts — o servidor a partir do código-fonte, sem build
```

O `tsconfig.build.json` estende o `tsconfig.json` (por isso o `pnpm typecheck` e
o build nunca discordam), compila só o `src/` — os testes e o `bin/` (os
geradores, a ponte de IA só de dev) ficam de fora — e mantém `rootDir: "."`, para
que o `src/server.ts` fique em `dist/src/server.js`.

O scaffold traz também um `Dockerfile` — o mesmo ficheiro que o
`basalt publish dockerfile` escreve, a partir de uma única fonte no `@basaltkit/cli`:

| Stage | O que faz |
| --- | --- |
| `build` | `pnpm install --frozen-lockfile` (com as devDependencies), `prisma generate` quando existe `prisma/schema.prisma`, `pnpm run build`, e depois `pnpm prune --prod --ignore-scripts` — o tsx, o TypeScript, a CLI do Prisma, os geradores e o `@basaltkit/ai-mcp` nunca chegam à imagem |
| `run` | `node:22-slim`, `NODE_ENV=production`, copia `node_modules`, `dist/` e `generated/`, corre como `USER node`, `HEALTHCHECK` em `$HEALTHCHECK_PATH` (por omissão `/health`, a rota do scaffold — define `/readyz` com o `healthPlugin`), `CMD ["node", "--enable-source-maps", "dist/src/server.js"]` |

```bash
docker build -t my-saas .
docker run -p 3000:3000 -e MY_SAAS_APP_SECRET=… -e MY_SAAS_DATABASE_URL=… my-saas
```

A configuração vem do ambiente: a imagem não carrega nenhum `.env`, e o
`.dockerignore` mantém-no (e as chaves, o `node_modules`, um `dist/` local) fora
do contexto de build. **A imagem não corre as migrações** — aplica-as antes de
fazer o rollout (`pnpm db:deploy` no CI ou num job de release); a app recusa
arrancar numa base de dados por migrar (`assertMigrated`). Uma app Prisma precisa
do cliente fora do `src/` e do `@prisma/client-runtime-utils` como dependência
direta — vê [Prisma com pnpm](/pt/guide/persistence#prisma-com-pnpm-o-cliente-gerado).

Uma app gerada antes disto existir: o `pnpm basalt update` oferece o
`tsconfig.build.json`, o script `build` e o Dockerfile, e imprime a mudança do
`start` em vez de a fazer; o `pnpm basalt doctor` diz o que falta. A suite do
create-basalt faz o build de scaffolds novos e arranca o
`node dist/src/server.js` até o `/health` responder.

::: tip Deploy para o teu próprio servidor
Num único servidor Linux (PM2 ou Docker Compose atrás de Apache ou Caddy), o
`@basaltkit/deploy` trata da release inteira, migrações incluídas, e o
`@basaltkit/deploy-ui` controla-o a partir da tua máquina. Vê
[Deploy para um servidor](/pt/guide/deploy).
:::

## Encerramento gracioso

`app.shutdown()` corre o `shutdown` de cada plugin na ordem inversa do boot
(fechando o servidor, drenando pools). Liga-o aos sinais:

```ts
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
```

## CI/CD

O repositório inclui GitHub Actions que fazem gate a cada PR:

- **CI** — build, typecheck e teste em Node 22 & 24; um job de **cobertura** que
  impõe thresholds (`pnpm test:coverage`); um job de **integração** com Postgres.
- **audit** — `pnpm audit --audit-level=high`.
- **CodeQL** — análise estática, semanal + em PRs.
- **Release** — os changesets abrem um PR de versão e publicam no npm com
  **provenance** no merge.

## Fiabilidade

- **Outbox** (`@basaltkit/events`) — escreve eventos num store durável, retransmite-os
  para sistemas externos com retries, backoff exponencial e um teto de dead-letter.
  Entrega at-least-once que sobrevive a crashes — desde que o store seja durável,
  a entrada seja escrita na transação de negócio (`enqueue(…, { tx })`), e o
  `onDead` / `onFlushError` cheguem a um humano. Com várias réplicas, usa um store
  que reclama (`prismaOutboxStore(prisma, { claim: true })`) para os relays não
  despacharem em duplicado. As opções estão em
  [Persistence](/pt/guide/persistence); o lado da entrega em
  [Webhooks](/pt/guide/webhooks).
- **Webhooks** (`@basaltkit/webhooks`) — entrega de saída assinada com backoff,
  subscrições por tenant, despachados automaticamente a partir de eventos de domínio.
- **Filas** (`@basaltkit/queue`) — trabalho em segundo plano com reporte `onError` /
  `onJobFailed` ao nível do driver; ver [Filas](/pt/guide/queues).
- **Realtime** (`@basaltkit/realtime`) — os pushes são fire-and-forget por design e
  nunca podem falhar uma escrita de domínio, o que também significa que as suas
  falhas só são visíveis através do `onBridgeError` / `onDeliveryError`. Ver
  [Realtime](/pt/guide/realtime).
- **Feature flags** (`@basaltkit/flags`) — targeting por tenant/utilizador e
  rollouts determinísticos para lançamentos seguros e graduais.

## Gates de qualidade

`pnpm lint` (ESLint), `pnpm typecheck`, e `pnpm test:coverage` (V8, thresholds
impostos) correm todos em CI, a par de `pnpm audit`, CodeQL e um job de integração
com Postgres. Cada pacote `@basaltkit/*` é versionado de forma **independente** —
depende de cada um com o seu próprio intervalo `^`; o número "Basalt X.Y" na
navegação é uma etiqueta para uma geração da framework, não a versão de um pacote.
Ver [Versionamento e compatibilidade](/pt/guide/versioning).

## Roadmap

Passado o `1.0`, a API pública é estável e as mudanças breaking esperam por um
major. A seguir: exportação de **métricas** OpenTelemetry de primeira classe (os
traces já exportam via OTLP), e mais adaptadores de persistência. Acompanha o
progresso no [repositório](https://github.com/basaltkit/basalt), e vê
[Novidades](/pt/guide/whats-new) para a geração atual.
