# Introduction

Machize is a batteries-included toolkit for building SaaS applications on
Node.js. It is not another HTTP framework — Fastify already does that well. It
fills the layer between the server and a finished SaaS product: **tenancy,
billing, auth, permissions, audit, queues, notifications** — integrated with
the coherence Laravel brings to PHP, and TypeScript inference from the route to
the client.

## Why Machize

- **Self-hosted, no lock-in.** Your data lives in your PostgreSQL, your users
  authenticate against your database. Gateways like Stripe are drivers, not
  owners of your state.
- **Multi-tenancy as a first-class citizen.** Unlike most Node stacks where
  tenancy is bolted on, the tenant context permeates cache, storage, queue,
  logger and Prisma natively through `AsyncLocalStorage`.
- **Convention over configuration.** A Machize app runs with zero config;
  everything is overridable.
- **Incremental adoption.** Every package works on its own in an existing
  Fastify app. The full framework is the destination, not the toll to enter.

## The 30-second tour

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin, FASTIFY, route } from '@machize/fastify'
import { z } from 'zod'

const hello = route({
  method: 'GET',
  url: '/hello/:name',
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    return { message: `Hello, ${params.name}` }
  },
})

const app = await createApp({ plugins: [fastifyPlugin({ routes: [hello] })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

The route's `params` type is inferred from the Zod schema — the handler is fully
typed, and the same schema can feed OpenAPI and the [SDK client](/reference/packages).

Ready to build something real? [Install Machize](/guide/installation) or jump to
the [multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas).
