# Construir um SaaS de notas (de ponta a ponta)

Este tutorial constrói um **SaaS multi-tenant completo** a partir de uma pasta
vazia até uma app com forma de produção: tenants com uma **quota de notas baseada
no plano** (basic = 5, pro = 10), autenticação, um **painel de administração de
operador** e uma troca para **Prisma** (base de dados) e **Redis** (cache, filas,
quota) para produção.

No fim terás exatamente a demo `notes` de referência — API, testes e uma app web
de duas áreas (consola de administração + workspace do tenant).

[[toc]]

## O que estamos a construir

```
Operator ──(admin key)──▶  Admin console: metrics + create tenants
Tenant   ──(JWT + slug)─▶  Workspace: create/list/delete notes (quota-limited)
```

- **Tenancy** — cada tenant é isolado (cabeçalho `x-tenant-id` ou subdomínio).
- **Quota como funcionalidade consumível** — o limite de `notes` de um plano é
  gasto uma nota de cada vez, imposto atomicamente pelo usage store das
  subscrições.
- **Painel de administração** — métricas de faturação + utilização por tenant via
  `@basaltkit/dashboard`.
- **Trocas para produção** — em memória → Prisma + Redis, sem alterações ao
  domínio.

## 1. Scaffold

```bash
npm create basalt notes -- --billing --cli
cd notes && pnpm install
```

`--billing` adiciona `@basaltkit/subscriptions`; `--cli` adiciona os geradores
`basalt`. Adiciona os dois pacotes extra que esta demo usa:

```bash
pnpm add @basaltkit/dashboard @basaltkit/permissions
```

## 2. Ambiente

Os segredos são **fail-closed em produção** — `secret()` exige um valor real aí e
rejeita placeholders, mantendo ao mesmo tempo um default de dev para execuções
locais.

```ts
// src/env.ts
import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

export const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
  ADMIN_KEY: secret({ devDefault: 'dev-only-admin-key-value' }),
  // Usado mais tarde, para produção:
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
})
```

## 3. Planos e a quota de notas

`notes` é uma funcionalidade **consumível** — criar uma nota consome uma, e o
usage store impõe o limite atomicamente (para que uma corrida nunca ultrapasse).

```ts
// src/billing.ts
import { definePlans } from '@basaltkit/subscriptions'

export const plans = definePlans({
  basic: { price: 0, features: { notes: 5 } },
  pro: { price: { monthly: 9, yearly: 90 }, trial: '14d', features: { notes: 10 } },
})
export type PlanName = 'basic' | 'pro'
```

## 4. Papéis

```ts
// src/access.ts
import type { AccessStore } from '@basaltkit/permissions'

export const ROLES = {
  owner: ['*'],
  member: ['notes:read', 'notes:create', 'notes:delete'],
} as const
export type Role = keyof typeof ROLES

export async function seedRoles(store: AccessStore, tenantId: string): Promise<void> {
  for (const [role, permissions] of Object.entries(ROLES)) {
    await store.grantToRole(role, [...permissions], tenantId)
  }
}
```

## 5. O domínio

```ts
// src/domain.ts
import { createToken } from '@basaltkit/core'
import { defineEvent } from '@basaltkit/events'
import { z } from 'zod'

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  authorId: z.string(),
  createdAt: z.string(),
})
export type Note = z.infer<typeof NoteSchema>

export const CreateNoteSchema = z.object({ title: z.string().min(1).max(120), body: z.string().max(10_000).default('') })
export type CreateNoteInput = z.infer<typeof CreateNoteSchema>

export const NoteCreated = defineEvent('note.created', NoteSchema)
export const NoteDeleted = defineEvent('note.deleted', NoteSchema)

export const NOTE_SERVICE = createToken<import('./services.js').NoteService>('notes:service')
export const ONBOARDING = createToken<import('./services.js').OnboardingService>('notes:onboarding')
export const ADMIN_SERVICE = createToken<import('./services.js').AdminService>('notes:admin')
```

## 6. Um repositório com âmbito de tenant

O repositório lê o tenant a partir do contexto do pedido e particiona os dados
por ele — o mesmo isolamento que uma base de dados real te dá. (Trocamos isto por
Prisma no [passo 12](#_12-going-to-production-prisma).)

```ts
// src/repositories.ts
import { randomUUID } from 'node:crypto'
import { tryCtx } from '@basaltkit/core'
import type { CreateNoteInput, Note } from './domain.js'

export class NoteRepository {
  private readonly partitions = new Map<string, Map<string, Note>>()
  private store(): Map<string, Note> {
    const tenant = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id ?? 'central'
    let p = this.partitions.get(tenant)
    if (!p) this.partitions.set(tenant, (p = new Map()))
    return p
  }
  all() { return [...this.store().values()] }
  find(id: string) { return this.store().get(id) }
  create(input: CreateNoteInput, authorId: string): Note {
    const note: Note = { id: randomUUID(), ...input, authorId, createdAt: new Date().toISOString() }
    this.store().set(note.id, note)
    return note
  }
  delete(id: string) { return this.store().delete(id) }
}
```

## 7. Serviços

O coração da app. `NoteService.create` **consome** a quota; `OnboardingService`
aprovisiona um tenant; `AdminService` constrói o painel.

```ts
// src/services.ts
import { ctx } from '@basaltkit/core'
import type { EventBus } from '@basaltkit/events'
import { HttpError } from '@basaltkit/fastify'
import type { Auth } from '@basaltkit/auth'
import type { AccessStore } from '@basaltkit/permissions'
import type { Subscriptions, SubscriptionStore, Plans } from '@basaltkit/subscriptions'
import type { MemoryTenantSource } from '@basaltkit/tenancy'
import { computeBillingMetrics } from '@basaltkit/dashboard'
import { seedRoles, type Role } from './access.js'
import { NoteCreated, type CreateNoteInput, type Note } from './domain.js'
import type { NoteRepository } from './repositories.js'
import type { PlanName } from './billing.js'

const tenantId = (): string => {
  const id = (ctx()['tenant'] as { id?: string } | undefined)?.id
  if (!id) throw new HttpError(400, 'TENANT_REQUIRED', 'Missing tenant (x-tenant-id header).')
  return id
}
const currentUserId = (): string => (ctx()['user'] as { id: string }).id

export class NoteService {
  constructor(
    private readonly repo: NoteRepository,
    private readonly bus: EventBus,
    private readonly subscriptions: Subscriptions,
  ) {}

  list() { return this.repo.all() }

  async quota() {
    const f = this.subscriptions.features(tenantId())
    return { used: await f.usage('notes'), quota: await f.limit('notes'), remaining: await f.remaining('notes') }
  }

  /** Consome uma da quota do plano; lança QuotaExceededError (402) quando esgotada. */
  async create(input: CreateNoteInput): Promise<Note> {
    await this.subscriptions.features(tenantId()).consume('notes')
    const note = this.repo.create(input, currentUserId())
    await this.bus.emit(NoteCreated, note)
    return note
  }
}

export interface SignupInput { tenant: string; tenantName: string; name: string; email: string; password: string; plan: PlanName }

export class OnboardingService {
  constructor(
    private readonly tenants: MemoryTenantSource,
    private readonly access: AccessStore,
    private readonly auth: Auth,
    private readonly subscriptions: Subscriptions,
  ) {}

  async signup(input: SignupInput) {
    const id = input.tenant.toLowerCase()
    if (await this.tenants.find(id)) throw new HttpError(409, 'TENANT_TAKEN', `"${id}" already exists.`)
    await this.tenants.add({ id, name: input.tenantName })
    await seedRoles(this.access, id)
    const owner = await this.auth.register(input.email, input.password)
    await this.access.assignRole(owner.id, 'owner' satisfies Role, id)
    await this.subscriptions.subscribe(id, input.plan)
    const { tokens } = await this.auth.login(input.email, input.password)
    return { tenant: { id, name: input.tenantName }, plan: input.plan, owner, ...tokens }
  }
}

export class AdminService {
  constructor(
    private readonly tenants: MemoryTenantSource,
    private readonly subscriptions: Subscriptions,
    private readonly subStore: SubscriptionStore,
    private readonly plans: Plans,
  ) {}

  async dashboard() {
    const tenants = await this.tenants.list()
    const rows = await Promise.all(tenants.map(async (t) => {
      const f = this.subscriptions.features(t.id)
      const record = await this.subStore.get(t.id)
      return {
        id: t.id, name: String(t['name'] ?? t.id), plan: record?.plan ?? null,
        notesUsed: await f.usage('notes'), notesQuota: await f.limit('notes'), notesRemaining: await f.remaining('notes'),
      }
    }))
    const metrics = computeBillingMetrics(await this.subStore.all(), this.plans)
    return { metrics, tenants: rows, totals: { tenants: rows.length, notesUsed: rows.reduce((s, r) => s + r.notesUsed, 0) } }
  }
}
```

## 8. Ligar o plugin de domínio

```ts
// src/plugin.ts
import { definePlugin } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import { AUTH } from '@basaltkit/auth'
import type { AccessStore } from '@basaltkit/permissions'
import { SUBSCRIPTIONS, type Plans, type SubscriptionStore } from '@basaltkit/subscriptions'
import type { MemoryTenantSource } from '@basaltkit/tenancy'
import { ADMIN_SERVICE, NOTE_SERVICE, ONBOARDING } from './domain.js'
import { NoteRepository } from './repositories.js'
import { AdminService, NoteService, OnboardingService } from './services.js'

export interface NotesPluginDeps { tenants: MemoryTenantSource; access: AccessStore; subStore: SubscriptionStore; plans: Plans }

export function notesPlugin(deps: NotesPluginDeps) {
  const notes = new NoteRepository()
  return definePlugin({
    name: 'app:notes',
    dependsOn: ['basalt:events', 'basalt:auth', 'basalt:permissions', 'basalt:subscriptions'],
    register({ container }) {
      container.singleton(NOTE_SERVICE, (c) => new NoteService(notes, c.get(EVENTS), c.get(SUBSCRIPTIONS)))
      container.singleton(ONBOARDING, (c) => new OnboardingService(deps.tenants, deps.access, c.get(AUTH), c.get(SUBSCRIPTIONS)))
      container.singleton(ADMIN_SERVICE, (c) => new AdminService(deps.tenants, c.get(SUBSCRIPTIONS), deps.subStore, deps.plans))
    },
  })
}
```

## 9. Rotas

O `meta` da rota conduz os guards: `auth: true` exige login; `can` exige uma
permissão. As rotas de administração verificam a chave do operador.

```ts
// src/routes.ts
import { ctx, type Container, type Token } from '@basaltkit/core'
import { HttpError, route, type HttpRequest } from '@basaltkit/fastify'
import { z } from 'zod'
import { env } from './env.js'
import { ADMIN_SERVICE, CreateNoteSchema, NOTE_SERVICE, ONBOARDING } from './domain.js'

const service = <T>(token: Token<T>): T => (ctx().container as Container).get(token)
function requireAdmin(request: HttpRequest): void {
  if (request.headers['x-admin-key'] !== env.ADMIN_KEY) throw new HttpError(401, 'ADMIN_UNAUTHORIZED', 'A valid x-admin-key is required.')
}

export const appRoutes = [
  route({ method: 'POST', url: '/signup',
    body: z.object({ tenant: z.string().min(2), tenantName: z.string().min(2), name: z.string().min(2), email: z.string().email(), password: z.string().min(8), plan: z.enum(['basic', 'pro']).default('basic') }),
    async handler({ body, reply }) { return reply.code(201).send(await service(ONBOARDING).signup(body)) } }),

  route({ method: 'GET', url: '/notes', meta: { auth: true, can: 'notes:read' }, async handler() { return service(NOTE_SERVICE).list() } }),
  route({ method: 'GET', url: '/notes/quota', meta: { auth: true, can: 'notes:read' }, async handler() { return service(NOTE_SERVICE).quota() } }),
  route({ method: 'POST', url: '/notes', meta: { auth: true, can: 'notes:create' }, body: CreateNoteSchema,
    async handler({ body, reply }) { return reply.code(201).send(await service(NOTE_SERVICE).create(body)) } }),
  route({ method: 'DELETE', url: '/notes/:id', meta: { auth: true, can: 'notes:delete' }, params: z.object({ id: z.string() }),
    async handler({ params, reply }) { /* … delete … */ return reply.code(204).send() } }),

  // SaaS operator
  route({ method: 'GET', url: '/admin/dashboard', async handler({ request }) { requireAdmin(request); return service(ADMIN_SERVICE).dashboard() } }),
  route({ method: 'POST', url: '/admin/tenants',
    body: z.object({ tenant: z.string().min(2), tenantName: z.string().min(2), ownerName: z.string().min(2), ownerEmail: z.string().email(), ownerPassword: z.string().min(8), plan: z.enum(['basic', 'pro']).default('basic') }),
    async handler({ body, request, reply }) {
      requireAdmin(request)
      const r = await service(ONBOARDING).signup({ tenant: body.tenant, tenantName: body.tenantName, name: body.ownerName, email: body.ownerEmail, password: body.ownerPassword, plan: body.plan })
      return reply.code(201).send({ tenant: r.tenant, plan: r.plan, owner: r.owner })
    } }),
]
```

## 10. Montar a app

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { eventsPlugin } from '@basaltkit/events'
import { fastifyPlugin } from '@basaltkit/fastify'
import { loggerPlugin } from '@basaltkit/logger'
import { headerResolver, MemoryTenantSource, subdomainResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'
import { MemoryAccessStore, permissionsPlugin } from '@basaltkit/permissions'
import { MemorySubscriptionStore, MemoryUsageStore, subscriptionsPlugin } from '@basaltkit/subscriptions'
import { env } from './env.js'
import { plans } from './billing.js'
import { notesPlugin } from './plugin.js'
import { appRoutes } from './routes.js'

export function buildApp(options: { logLevel?: string } = {}) {
  const tenants = new MemoryTenantSource()
  const subStore = new MemorySubscriptionStore()
  return createApp({
    plugins: [
      configPlugin({ app: { name: 'notes' } }),
      loggerPlugin({ level: options.logLevel ?? 'info' }),
      eventsPlugin(),
      tenancyPlugin({ source: tenants, resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })] }),
      authPlugin({ users: new MemoryUserSource(), secret: env.APP_SECRET }),
      permissionsPlugin({ store: new MemoryAccessStore() }),
      subscriptionsPlugin({ plans, fallbackPlan: 'basic', store: subStore, usage: new MemoryUsageStore() }),
      notesPlugin({ tenants, access: /* the same store */ new MemoryAccessStore(), subStore, plans }),
      fastifyPlugin({ routes: [...appRoutes, ...authRoutes()] }),
    ],
  })
}
```

::: tip Um store, dois leitores
Cria o `MemoryAccessStore` / `MemorySubscriptionStore` **uma vez** e passa a mesma
instância tanto ao plugin como aos teus serviços, para que o painel de
administração leia os mesmos dados que a app escreve.
:::

## 11. Executar e experimentar

```bash
pnpm dev
```

```bash
# o operador aprovisiona um tenant no plano basic (5 notas)
curl -s localhost:3000/admin/tenants -H "x-admin-key: dev-only-admin-key-value" \
  -H content-type:application/json \
  -d '{"tenant":"acme","tenantName":"Acme","ownerName":"Ada","ownerEmail":"ada@acme.test","ownerPassword":"password123","plan":"basic"}'

# o owner autentica-se e consome notas — a 6ª devolve 402
TOKEN=$(curl -s localhost:3000/auth/login -H content-type:application/json \
  -d '{"email":"ada@acme.test","password":"password123"}' | jq -r .accessToken)
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "note $i → %{http_code}\n" localhost:3000/notes \
    -H "x-tenant-id: acme" -H "authorization: Bearer $TOKEN" \
    -H content-type:application/json -d "{\"title\":\"Note $i\"}"
done
# → note 5 → 201, note 6 → 402
```

## 12. Ir para produção: Prisma

Troca o `NoteRepository` em memória por uma base de dados. Nada mais muda — o
tenant continua a ser lido a partir do contexto do pedido.

**a. Adiciona o Prisma** e um modelo `Note` com uma coluna `tenantId`:

```prisma
// prisma/schema.prisma
model Note {
  id        String   @id @default(cuid())
  tenantId  String
  title     String
  body      String   @default("")
  authorId  String
  createdAt DateTime @default(now())
  @@index([tenantId])
}
```

**b. Configura o `prismaPlugin`** com a extensão de tenancy — cada consulta fica
automaticamente no âmbito de `ctx().tenant`, tanto leituras *como* escritas:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

const prisma = new PrismaClient().$extends(tenancyExtension()) // scopes by tenantId

// in buildApp plugins, before notesPlugin:
prismaPlugin({ client: prisma })
```

**c. Reescreve o repositório** com `db()` — sem `where: { tenantId }` manual, a
extensão adiciona-o:

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

export class PrismaNoteRepository {
  private get notes() { return db<PrismaClient>().note }
  list() { return this.notes.findMany() }
  find(id: string) { return this.notes.findUnique({ where: { id } }) }
  create(input: CreateNoteInput, authorId: string) { return this.notes.create({ data: { ...input, authorId } }) }
  delete(id: string) { return this.notes.delete({ where: { id } }).then(() => true).catch(() => false) }
}
```

Gera toda esta vertical automaticamente com a CLI `basalt`:

```bash
pnpm basalt make:resource Note --prisma
```

### Base de dados por tenant

Para isolamento total, dá a cada tenant a sua **própria base de dados** em vez de
uma partilhada com uma coluna `tenantId` — o código de domínio é idêntico:

```ts
prismaPlugin({
  forTenant: (id) => new PrismaClient({ datasourceUrl: `${env.DATABASE_URL}/${id}` }),
})
```

Um pool LRU mantém o número de ligações limitado. Executa as migrações em todos os
tenants:

```ts
import { migrateTenants } from '@basaltkit/prisma'
await migrateTenants({ tenants: await listTenantIds(), target: { mode: 'database', urlFor: (id) => `${env.DATABASE_URL}/${id}` } })
```

Vê [Ir para Produção → Persistência](/pt/guide/production#persistence) para as três
estratégias de tenancy (partilhada / schema-por-tenant / base-de-dados-por-tenant).

## 13. Ir para produção: Redis

Três sítios beneficiam do Redis. Todos são trocas de uma linha.

**a. A quota de notas** — suporta o usage store das subscrições com Redis para que
o check-and-increment atómico funcione entre instâncias:

```ts
import { Redis } from 'ioredis'
import { RedisUsageStore } from '@basaltkit/subscriptions'

const redis = new Redis(env.REDIS_URL!)
subscriptionsPlugin({ plans, fallbackPlan: 'basic', store: subStore, usage: new RedisUsageStore(redis) })
```

**b. Cache** — memoiza leituras (ex.: o painel de administração) com uma cache
Redis:

```ts
import { cachePlugin, CACHE } from '@basaltkit/cache'

cachePlugin({ driver: 'redis', url: env.REDIS_URL })

// in a service:
const dashboard = await cache.remember('admin:dashboard', '30s', () => this.build())
```

**c. Tarefas em background** — envia um email de boas-vindas a partir de
`note.created` sem bloquear o pedido, através de uma fila BullMQ (Redis):

```ts
import { defineJob, QUEUE } from '@basaltkit/queue'
import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

const SendWelcome = defineJob('welcome', z.object({ email: z.string() }), async ({ email }) => {
  await mailer.send({ to: email, subject: 'Welcome!' })
})

bullmqQueuePlugin({ connection: env.REDIS_URL, jobs: [SendWelcome], workers: [{ queue: 'welcome', concurrency: 5 }] })

// dispatch from a domain-event listener (in your plugin's boot):
bus.on('note.created', () => void container.get(QUEUE).dispatch(SendWelcome, { email }))
```

Sem uma `connection`, a fila corre **de forma síncrona** — por isso os testes e o
dev local não precisam de Redis nenhum.

## 14. Reforçar a periferia

Os plugins de periferia neutros em relação ao framework adicionam preocupações de
produção sem tocar nas tuas rotas ([Segurança](/pt/guide/security),
[Observabilidade](/pt/guide/observability)):

```ts
import { securityPlugin, healthPlugin, metricsPlugin, tracingPlugin } from '@basaltkit/fastify'

securityPlugin({ rateLimit: { limit: 300, windowMs: 60_000 }, cors: { origin: env.WEB_ORIGIN }, headers: true }),
healthPlugin({ checks: { db: () => ({ ok: prisma != null }), redis: async () => ({ ok: (await redis.ping()) === 'PONG' }) } }),
metricsPlugin(),   // Prometheus /metrics
tracingPlugin(),   // W3C trace-context + OTLP
```

A autenticação já limita logins por força bruta, e o `POST` pode tornar-se
idempotente com `idempotencyPlugin()`.

## 15. A app web

Um frontend React + shadcn/ui (type-safe via `@basaltkit/sdk`) dá ao operador uma
consola de **painel + criação de tenants** e a cada tenant um **workspace** para
consumir as suas notas — vê a pasta `web/` da app `notes` de referência. São as
mesmas rotas que construíste aqui, consumidas através de um cliente gerado; o
servidor de dev do Vite faz proxy de `/api` para o backend (sem CORS). Vê
[Adaptadores HTTP](/pt/guide/adapters) para servir em Express ou Hono em vez de
Fastify.

## 16. Testar de ponta a ponta

```ts
// tests/notes.e2e.test.ts
import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from '../src/app.js'

const app = await buildApp({ logLevel: 'silent' }).boot()
const server = app.container.get(FASTIFY)

// basic plan allows exactly 5 notes, then 402
for (let i = 1; i <= 5; i++) expect((await createNote('acme', `n${i}`)).statusCode).toBe(201)
expect((await createNote('acme', 'overflow')).statusCode).toBe(402)
```

Tudo corre em stores em memória, por isso a suite inteira passa **sem base de
dados nem Redis** — troca-os apenas para produção. É esse o objetivo: o código de
domínio que escreveste nos passos 3–9 nunca muda.
