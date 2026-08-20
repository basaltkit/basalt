# Basalt beyond SaaS

Basalt is marketed as a multi-tenant SaaS toolkit, but that's just the headline.
Underneath, it's a **general-purpose TypeScript backend framework** — the
SaaS-specific parts are opt-in plugins you can leave out entirely.

## The core is not SaaS-specific

What actually makes Basalt run has nothing to do with multi-tenancy:

- **Core** — a plugin lifecycle, a dependency-injection container, a request
  context (`ctx()`), and a hook bus.
- **HTTP adapters** (Fastify / Express / Hono) — routing, Zod validation, OpenAPI.

Everything else is a building block you wire **only if you need it**. The
multi-tenant pieces are just a few of them.

| General (any app) | SaaS-specific (opt-in) |
| --- | --- |
| core, http/fastify, prisma, queues, mailer, storage, search, cache, realtime, logger/metrics/tracing, config/env, webhooks, activity, i18n, exports, flags | **tenancy** (multi-tenant), **teams**, **subscriptions / billing**, **payments** |

If you don't register `tenancyPlugin` / `subscriptionsPlugin` / `teamsPlugin`,
they simply don't exist in your app. `ctx().tenant` stays `undefined`, and since
you never run tenant-scoped queries, nothing breaks.

## A minimal, SaaS-free API

```ts
import { createApp } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { loggerPlugin } from '@basaltkit/logger'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { z } from 'zod'

const app = await createApp({
  plugins: [
    configPlugin({ app: { name: 'my-api' } }),
    loggerPlugin({ level: 'info' }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/hello/:name',
          params: z.object({ name: z.string() }),
          async handler({ params }) {
            return { message: `Hello, ${params.name}` }
          },
        }),
      ],
    }),
  ],
}).boot()
```

No tenancy, no auth, no billing — just a normal Node/TypeScript backend.

## What you can build

- A plain **REST / RPC API** (core + http only).
- A **single-tenant app** for one organization — use `authPlugin` **without**
  `tenancyPlugin`.
- An **internal tool / admin** — maybe without auth at all.
- A **worker / job processor** — just `queuePlugin`, no HTTP server needed.
- A **CLI** — `@basaltkit/cli` plus your own commands.
- A traditional web monolith.

## The practical rule

Start with **core + fastify**, then add **only** what the app needs:

- Need to store data? → `prismaPlugin`.
- Emails? → `mailerPlugin`. Background work? → `queuePlugin`. Full-text search? →
  `searchPlugin`.
- One organization only? → `authPlugin` **without** `tenancyPlugin`.

::: tip
A multi-tenant SaaS is the *same base* with **more plugins in the array**. A
non-SaaS app is that base with **fewer**. Nothing about the core changes.
:::

::: warning Auth is optional too
`authPlugin` is useful in many apps, not just SaaS — but it's still opt-in. An
internal tool behind a VPN might skip it entirely. Add it when you need to know
*who* is calling; leave it out when you don't.
:::
