# Core Concepts

Everything in Basalt is built on a small foundation: an application with a
plugin lifecycle, a dependency-injection container, and a request context that
flows through the whole call stack.

## The application

`createApp` assembles plugins and boots them in dependency order.

```ts
import { createApp } from '@basaltkit/core'

const app = await createApp({
  plugins: [configPlugin, loggerPlugin, tenancyPlugin, authPlugin],
}).boot()

// ... later, graceful shutdown (reverse boot order)
await app.shutdown()
```

## Plugins

A plugin is the unit of composition — every package ships one. Plugins declare
their dependencies, register services and connect resources.

```ts
import { definePlugin, createToken } from '@basaltkit/core'

export const MAILER = createToken<Mailer>('mailer')

export const mailerPlugin = definePlugin({
  name: 'basalt:mailer',
  dependsOn: ['basalt:config'],
  register({ container, config }) {
    container.singleton(MAILER, () => new SmtpMailer(config))
  },
  async shutdown({ container }) {
    await container.get(MAILER).close()
  },
})
```

`dependsOn` produces a topological boot order; a cycle is a startup error that
names the cycle.

## Dependency injection without decorators

The container uses **typed tokens and factory functions** — no decorators, no
`reflect-metadata`. That means it works on any bundler and runtime, the
dependency graph is explicit, and tree-shaking works.

```ts
const mailer = container.get(MAILER) // fully typed, no reflection
```

## Context (AsyncLocalStorage)

`ctx()` returns the active request/job context anywhere in the call stack —
handlers, services, jobs, listeners — without passing parameters. It carries the
request id, correlation id, the current tenant, the authenticated user and the
scoped database client.

```ts
import { ctx } from '@basaltkit/core'

export async function anyService() {
  const { tenant, user, logger, db } = ctx()
  logger.info('processing') // already tagged with tenantId + requestId
}
```

This is the backbone that lets cache, storage, queue, logger and Prisma isolate
per tenant automatically — they all read the tenant from the context, so your
code never threads it through by hand.

## Events

Domain events are typed and decoupled. Cross-cutting concerns like audit
subscribe with wildcards instead of touching every call site.

```ts
import { defineEvent, on } from '@basaltkit/events'
import { z } from 'zod'

export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

on(OrderCreated, async ({ orderId }) => { /* ... */ })
on('order.*', auditListener) // wildcard
```
