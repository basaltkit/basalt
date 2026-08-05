# A multi-tenant SaaS

This recipe assembles a small but real multi-tenant SaaS: tenants resolved from
the request, isolated data, and a domain event feeding an audit trail — the same
shape the reference `playground` app uses.

## 1. Boot the app

```ts
import { createApp } from '@machize/core'
import { eventsPlugin } from '@machize/events'
import { loggerPlugin } from '@machize/logger'
import { fastifyPlugin } from '@machize/fastify'
import {
  tenancyPlugin,
  MemoryTenantSource,
  headerResolver,
  subdomainResolver,
} from '@machize/tenancy'
import { projectRoutes } from './routes.js'
import { projectPlugin } from './plugin.js'

export function buildApp() {
  return createApp({
    plugins: [
      loggerPlugin(),
      eventsPlugin(),
      tenancyPlugin({
        source: new MemoryTenantSource()
          .add({ id: 'acme', name: 'Acme Inc' })
          .add({ id: 'globex', name: 'Globex' }),
        resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
      }),
      projectPlugin,
      fastifyPlugin({ routes: projectRoutes }),
    ],
  })
}
```

## 2. A tenant-scoped repository

In shared-database mode with `@machize/prisma`, every query scopes to
`ctx().tenant` automatically. Here is the idea in miniature:

```ts
import { ctx } from '@machize/core'

export class ProjectRepository {
  private readonly stores = new Map<string, Map<string, Project>>()

  create(name: string): Project {
    const project = { id: crypto.randomUUID(), name }
    this.store().set(project.id, project)
    return project
  }

  list(): Project[] {
    return [...this.store().values()]
  }

  private store() {
    const scope = ctx().tenant?.id ?? 'central'
    let store = this.stores.get(scope)
    if (!store) this.stores.set(scope, (store = new Map()))
    return store
  }
}
```

## 3. Routes that emit domain events

```ts
import { ctx, type Container } from '@machize/core'
import { EVENTS } from '@machize/events'
import { route } from '@machize/fastify'
import { z } from 'zod'
import { ProjectCreated, PROJECTS } from './domain.js'

const scope = () => ctx().container as Container

export const projectRoutes = [
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(3) }),
    async handler({ body, reply }) {
      const project = scope().get(PROJECTS).create(body.name)
      await scope().get(EVENTS).emit(ProjectCreated, project)
      return reply.code(201).send(project)
    },
  }),
  route({
    method: 'GET',
    url: '/projects',
    async handler() {
      return scope().get(PROJECTS).list()
    },
  }),
]
```

## 4. Audit via a wildcard listener

The tenant comes from the context — the emitter never passes it, and the same
listener covers every project event:

```ts
bus.on('project.**', (payload, meta) => {
  audit.push({ event: meta.name, payload, tenantId: ctx().tenant?.id ?? null })
})
```

## 5. See the isolation

```bash
# create a project for Acme
curl -X POST localhost:3000/projects -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' -d '{"name":"Acme Project"}'

curl localhost:3000/projects -H 'x-tenant-id: acme'    # → [ Acme Project ]
curl localhost:3000/projects -H 'x-tenant-id: globex'  # → []
curl localhost:3000/tenant   -H 'Host: acme.localhost' # → { id: "acme" }
```

One endpoint, isolated worlds — and cache, storage, queue and logs followed the
tenant without a single extra line. That is the whole point.
