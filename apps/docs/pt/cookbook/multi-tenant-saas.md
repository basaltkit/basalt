# Um SaaS multi-tenant

Esta receita monta um SaaS multi-tenant pequeno mas real: tenants resolvidos a
partir do pedido, dados isolados e um evento de domínio a alimentar um registo de
auditoria — a mesma forma que a app de referência `playground` usa.

## 1. Arrancar a app

```ts
import { createApp } from '@basaltkit/core'
import { eventsPlugin } from '@basaltkit/events'
import { loggerPlugin } from '@basaltkit/logger'
import { fastifyPlugin } from '@basaltkit/fastify'
import {
  tenancyPlugin,
  MemoryTenantSource,
  headerResolver,
  subdomainResolver,
} from '@basaltkit/tenancy'
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

## 2. Um repositório com âmbito de tenant

No modo de base de dados partilhada com `@basaltkit/prisma`, todas as consultas
ficam automaticamente no âmbito de `ctx().tenant`. Aqui está a ideia em miniatura:

```ts
import { ctx } from '@basaltkit/core'

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

## 3. Rotas que emitem eventos de domínio

```ts
import { ctx, type Container } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { route } from '@basaltkit/fastify'
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

## 4. Auditoria via um listener wildcard

O tenant vem do contexto — o emissor nunca o passa, e o mesmo listener cobre
todos os eventos de projeto:

```ts
bus.on('project.**', (payload, meta) => {
  audit.push({ event: meta.name, payload, tenantId: ctx().tenant?.id ?? null })
})
```

## 5. Ver o isolamento

```bash
# cria um projeto para a Acme
curl -X POST localhost:3000/projects -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' -d '{"name":"Acme Project"}'

curl localhost:3000/projects -H 'x-tenant-id: acme'    # → [ Acme Project ]
curl localhost:3000/projects -H 'x-tenant-id: globex'  # → []
curl localhost:3000/tenant   -H 'Host: acme.localhost' # → { id: "acme" }
```

Um endpoint, mundos isolados — e a cache, o armazenamento, a fila e os logs
seguiram o tenant sem uma única linha extra. É esse o objetivo todo.
