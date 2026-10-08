# Ir para Produção

Uma checklist para pôr uma app Basalt em produção, e onde vive cada capacidade.
A maior parte está ligada por predefinição — esta página é sobre fazer as
escolhas deliberadas, e sobre o punhado de coisas que só mordem em produção. Cada
linha liga ao guia que traz a tabela de opções completa; nada aqui repete uma.

[[toc]]

## Checklist

- [ ] **Segredos são fail-closed** — assina com `secret()` para que a produção
      recuse placeholders. Ver [Segurança](/pt/guide/security#segredos-fail-closed-secret).
- [ ] **A borda está protegida** — `securityPlugin({ rateLimit, cors, headers })`.
- [ ] **Logins são limitados** — ligado por predefinição em `@basaltkit/auth`.
- [ ] **Mutações são idempotentes** — `idempotencyPlugin()` para `POST`.
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
| Base de dados partilhada (nível de linha) | `prismaPlugin({ client: new PrismaClient().$extends(tenancyExtension()) })` |
| Base de dados por tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }) })` |
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

Quando uma base de dados já não aguenta a carga de leitura, acrescenta réplicas e
divide o tráfego: as leituras vão para as réplicas, as escritas ficam no primary.
O `readReplica` embrulha qualquer client Prisma e faz o routing — é um `Proxy`,
não uma dependência:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, readReplica } from '@basaltkit/prisma'

const client = readReplica({
  // aplica a MESMA extensão ao primary E às réplicas — nunca deixes uma réplica sem scoping
  // extend: (c) => c.$extends(tenancyExtension()),
  primary: new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }),
  replicas: [
    new PrismaClient({ datasourceUrl: process.env.REPLICA_1_URL }),
    new PrismaClient({ datasourceUrl: process.env.REPLICA_2_URL }),
  ],
})

app.use(prismaPlugin({ client }))
```

Multi-tenant? Passa `extend: (c) => c.$extends(tenancyExtension())` para **cada** réplica levar o teu filtro de tenant — uma réplica crua encaminharia leituras à volta dele e vazaria linhas. `$queryRaw`/`$queryRawUnsafe` ficam no **primary** por omissão (SQL raw pode mutar e leituras de gating não podem estar stale); opta por `rawReadsOnReplica: true` só para raw genuinamente read-only.

`findMany`, `findUnique`, `count`, `aggregate`, `groupBy` e `$queryRaw` fazem
round-robin pelas réplicas; toda a escrita, `$transaction` e `$executeRaw` vão
para o primary. Logo após uma escrita as réplicas podem estar atrasadas — força o
primary para um read-your-writes com o escape hatch `$primary`:

```ts
await db().order.create({ data })
const fresh = await db<Client>().$primary.order.findMany({ where: { userId } })
```

Com `replicas: []` devolve o primary inalterado, por isso a mesma montagem corre
em dev e num deploy de nó único. Usas `tenancyExtension()`? Estende o primary **e**
cada réplica, depois embrulha os clients estendidos. (TLS/detalhes de ligação são
do teu fornecedor de base de dados; o Basalt só encaminha as chamadas.)

## Fazer sharding da base de dados

As réplicas escalam leituras; o **sharding escala escritas e armazenamento**,
espalhando os tenants por várias bases de dados. O `ShardRouter` mapeia um id de
tenant para um shard com um hash estável — os dados de um tenant caem sempre na
mesma base:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, ShardRouter } from '@basaltkit/prisma'

const shards = new ShardRouter({
  shards: [
    new PrismaClient({ datasourceUrl: process.env.SHARD_0_URL }),
    new PrismaClient({ datasourceUrl: process.env.SHARD_1_URL }),
    new PrismaClient({ datasourceUrl: process.env.SHARD_2_URL }),
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
