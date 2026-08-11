# Ir para Produção

Uma checklist para pôr uma app Basalt em produção, e onde vive cada capacidade.
A maior parte está ligada por omissão — esta página é sobre fazer as escolhas
deliberadas.

## Checklist

- [ ] **Segredos são fail-closed** — assina com `secret()` para que a produção
      recuse placeholders. Ver [Segurança](/pt/guide/security#fail-closed-secrets-secret).
- [ ] **A borda está protegida** — `securityPlugin({ rateLimit, cors, headers })`.
- [ ] **Logins são limitados** — ligado por omissão em `@basaltkit/auth`.
- [ ] **Mutações são idempotentes** — `idempotencyPlugin()` para `POST`.
- [ ] **Sondas de saúde ligadas** — `healthPlugin({ checks })` para `/livez` + `/readyz`.
- [ ] **Métricas recolhidas** — `metricsPlugin()` em `/metrics`.
- [ ] **Tracing exportado** — `tracingPlugin({ exporter })` (OTLP).
- [ ] **API documentada** — `openapiPlugin({ info })`.
- [ ] **Entrega externa é fiável** — `outboxPlugin` / `webhooksPlugin`.
- [ ] **Base de dados real** — põe os dados do teu domínio em `@basaltkit/prisma`, e
      troca os stores em memória do framework (auth, teams, subscriptions, permissions,
      comments, audit, activity, notifications) pelos seus backends duráveis
      [`*-sqlite` / `*-prisma`](/pt/guide/persistence).
- [ ] **Migrações correm por tenant** — `migrateTenants()` / comando `basalt`.
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

::: tip Dica
Passa opções do servidor Fastify através de `fastifyPlugin({ fastify })`: `bodyLimit`
(tamanho máximo do pedido), `requestTimeout`, e `trustProxy` (para que o rate
limiting e o logging vejam o IP real do cliente por detrás de um load balancer).
:::

## Persistência

O desenvolvimento corre sobre stores em memória, por isso não há nada a instalar.
Em produção, `@basaltkit/prisma` oferece três estratégias de tenancy — o código de
domínio (`db().model.findMany()`) é idêntico nas três:

| Estratégia | Ativar com |
| --- | --- |
| Base de dados partilhada (nível de linha) | `prismaPlugin({ client: new PrismaClient().$extends(tenancyExtension()) })` |
| Base de dados por tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }) })` |
| Schema por tenant | `prismaPlugin({ schemaPerTenant: { url, createClient } })` |

Um `TenantClientPool` LRU integrado mantém a contagem de ligações limitada, e
`migrateTenants()` corre migrações em todos os tenants. Gera um recurso apoiado
em Prisma com `basalt make:resource Invoice --prisma`.

`@basaltkit/prisma` é para os dados de domínio **teus**. Os próprios domínios com
estado do framework — auth, teams, subscriptions, permissions, comments, audit,
activity e notifications — também são por omissão em memória e cada um tem um
backend durável para trocar: `@basaltkit/<domain>-sqlite` (single-node,
`node:sqlite`, zero dependências) ou `@basaltkit/<domain>-prisma` (Postgres/MySQL).
É uma alteração de uma linha por store porque o contrato não muda. Ver o
[guia de Persistência](/pt/guide/persistence) para o catálogo, e
[Base de dados por tenant](/pt/guide/database-per-tenant) para encaminhar esses
stores através do cliente do tenant ativo.

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
  para sistemas externos com retries e um teto de dead-letter. Entrega
  at-least-once que sobrevive a crashes. Ver [Webhooks](/pt/guide/webhooks).
- **Webhooks** (`@basaltkit/webhooks`) — entrega de saída assinada com backoff,
  subscrições por tenant, despachados automaticamente a partir de eventos de domínio.
- **Feature flags** (`@basaltkit/flags`) — targeting por tenant/utilizador e
  rollouts determinísticos para lançamentos seguros e graduais.

## Gates de qualidade

`pnpm lint` (ESLint), `pnpm typecheck`, e `pnpm test:coverage` (V8, thresholds
impostos) correm todos em CI, a par de `pnpm audit`, CodeQL e um job de integração
com Postgres. As versões movem-se em [lockstep](https://github.com/Zebedeu/basalt/blob/main/VERSIONING.md)
em todo o `@basaltkit/*`, por isso um só intervalo cobre todo o toolkit.

## Roadmap

Rumo a `1.0`: estabilizar a superfície da API, exportação de **métricas**
OpenTelemetry de primeira classe (os traces já exportam via OTLP), e mais adaptadores
de persistência. Acompanha o progresso no [repositório](https://github.com/Zebedeu/basalt).
