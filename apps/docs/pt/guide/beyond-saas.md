# Basalt para além do SaaS

O Basalt é apresentado como uma framework para SaaS multi-tenant, mas isso é só o
título. Por baixo, é um **framework de backend TypeScript genérico** — as partes
específicas de SaaS são plugins opcionais que podes deixar de fora por completo.

## O núcleo não é específico de SaaS

O que faz o Basalt funcionar não tem nada a ver com multi-tenancy:

- **Core** — ciclo de vida de plugins, um container de injeção de dependências,
  um contexto de pedido (`ctx()`) e um bus de hooks.
- **Adaptadores HTTP** (Fastify / Express / Hono) — rotas, validação Zod, OpenAPI.

Tudo o resto é uma peça que ligas **só se precisares**. As peças multi-tenant são
apenas algumas delas.

| Genérico (qualquer app) | Específico de SaaS (opcional) |
| --- | --- |
| core, http/fastify, prisma, filas, mailer, storage, pesquisa, cache, realtime, logger/métricas/tracing, config/env, webhooks, activity, i18n, exports, flags | **tenancy** (multi-tenant), **teams**, **subscrições / faturação**, **pagamentos** |

Se não registares o `tenancyPlugin` / `subscriptionsPlugin` / `teamsPlugin`, eles
simplesmente não existem na tua app. O `ctx().tenant` fica `undefined` e, como
nunca corres queries tenant-scoped, nada rebenta.

## Uma API mínima, sem SaaS

```ts
import { createApp } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { loggerPlugin } from '@basaltkit/logger'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { z } from 'zod'

const app = await createApp({
  plugins: [
    configPlugin({ app: { name: 'a-minha-api' } }),
    loggerPlugin({ level: 'info' }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/ola/:nome',
          params: z.object({ nome: z.string() }),
          async handler({ params }) {
            return { message: `Olá, ${params.nome}` }
          },
        }),
      ],
    }),
  ],
}).boot()
```

Sem tenancy, sem auth, sem faturação — apenas um backend Node/TypeScript normal.

## O que podes construir

- Uma **API REST / RPC** simples (só core + http).
- Uma **app de uma só organização** (single-tenant) — usas o `authPlugin`
  **sem** o `tenancyPlugin`.
- Uma **ferramenta interna / admin** — talvez sem auth de todo.
- Um **worker / processador de jobs** — só `queuePlugin`, sem servidor HTTP.
- Uma **CLI** — `@basaltkit/cli` mais os teus comandos.
- Um monólito web tradicional.

## A regra prática

Começa com **core + fastify** e depois liga **só** o que a app precisa:

- Precisas de guardar dados? → `prismaPlugin`.
- Emails? → `mailerPlugin`. Trabalho em background? → `queuePlugin`. Pesquisa
  full-text? → `searchPlugin`.
- Uma só organização? → `authPlugin` **sem** `tenancyPlugin`.

::: tip
Um SaaS multi-tenant é a *mesma base* com **mais plugins no array**. Uma app
não-SaaS é essa base com **menos**. Nada no núcleo muda.
:::

::: warning A auth também é opcional
O `authPlugin` é útil em muitas apps, não só em SaaS — mas continua a ser
opcional. Uma ferramenta interna atrás de uma VPN pode dispensá-lo por completo.
Liga-o quando precisas de saber *quem* está a chamar; deixa-o de fora quando não.
:::
