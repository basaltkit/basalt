# Build a notes SaaS (end to end)

This tutorial builds a **complete multi-tenant SaaS** from an empty folder to a
production-shaped app: tenants with a **plan-based note quota** (basic = 5,
pro = 10), authentication, an **operator admin dashboard**, and a swap to
**Prisma** (database) and **Redis** (cache, queues, quota) for production.

By the end you'll have exactly the reference `notes` demo — API, tests, and a
two-area web app (admin console + tenant workspace).

[[toc]]

## What we're building

```
Operator ──(admin key)──▶  Admin console: metrics + create tenants
Tenant   ──(JWT + slug)─▶  Workspace: create/list/delete notes (quota-limited)
```

- **Tenancy** — each tenant is isolated (`x-tenant-id` header or subdomain).
- **Quota as a consumable feature** — a plan's `notes` limit is spent one note
  at a time, enforced atomically by the subscriptions usage store.
- **Admin dashboard** — billing metrics + per-tenant usage via `@basaltkit/dashboard`.
- **Production swaps** — in-memory → Prisma + Redis, no domain changes.

## 1. Scaffold

```bash
npm create basalt notes -- --billing --cli
cd notes && pnpm install
```

`--billing` adds `@basaltkit/subscriptions`; `--cli` adds the `basalt` generators.
Add the two extra packages this demo uses:

```bash
pnpm add @basaltkit/dashboard @basaltkit/permissions
```

## 2. Environment

Secrets are **fail-closed in production** — `secret()` requires a real value
there and rejects placeholders, while keeping a dev default for local runs.

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
  // Used later, for production:
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
})
```

## 3. Plans and the note quota

`notes` is a **consumable** feature — creating a note consumes one, and the
usage store enforces the limit atomically (so a race never overshoots).

```ts
// src/billing.ts
import { definePlans } from '@basaltkit/subscriptions'

export const plans = definePlans({
  basic: { price: 0, features: { notes: 5 } },
  pro: { price: { monthly: 9, yearly: 90 }, trial: '14d', features: { notes: 10 } },
})
export type PlanName = 'basic' | 'pro'
```

## 4. Roles

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

## 5. The domain

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

## 6. A tenant-scoped repository

The repository reads the tenant from the request context and partitions data by
it — the same isolation a real database gives you. (We swap this for Prisma in
[step 12](#_12-going-to-production-prisma).)

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

## 7. Services

The heart of the app. `NoteService.create` **consumes** the quota;
`OnboardingService` provisions a tenant; `AdminService` builds the dashboard.

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

  /** Consumes one from the plan quota; throws QuotaExceededError (402) when spent. */
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

## 8. Wire the domain plugin

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

## 9. Routes

Route `meta` drives the guards: `auth: true` requires a login; `can` requires a
permission. The admin routes check the operator key.

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

## 10. Assemble the app

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

::: tip One store, two readers
Create the `MemoryAccessStore` / `MemorySubscriptionStore` **once** and pass the
same instance to both the plugin and your services, so the admin dashboard reads
the same data the app writes.
:::

## 11. Run and try it

```bash
pnpm dev
```

```bash
# operator provisions a tenant on the basic (5-note) plan
curl -s localhost:3000/admin/tenants -H "x-admin-key: dev-only-admin-key-value" \
  -H content-type:application/json \
  -d '{"tenant":"acme","tenantName":"Acme","ownerName":"Ada","ownerEmail":"ada@acme.test","ownerPassword":"password123","plan":"basic"}'

# the owner signs in and consumes notes — the 6th returns 402
TOKEN=$(curl -s localhost:3000/auth/login -H content-type:application/json \
  -d '{"email":"ada@acme.test","password":"password123"}' | jq -r .accessToken)
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "note $i → %{http_code}\n" localhost:3000/notes \
    -H "x-tenant-id: acme" -H "authorization: Bearer $TOKEN" \
    -H content-type:application/json -d "{\"title\":\"Note $i\"}"
done
# → note 5 → 201, note 6 → 402
```

## 12. Going to production: Prisma

Swap the in-memory `NoteRepository` for a database. Nothing else changes — the
tenant is still read from the request context.

**a. Add Prisma** and a `Note` model with a `tenantId` column:

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

**b. Configure `prismaPlugin`** with the tenancy extension — every query is
auto-scoped to `ctx().tenant`, reads *and* writes:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

const prisma = new PrismaClient().$extends(tenancyExtension()) // scopes by tenantId

// in buildApp plugins, before notesPlugin:
prismaPlugin({ client: prisma })
```

**c. Rewrite the repository** with `db()` — no manual `where: { tenantId }`,
the extension adds it:

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

Generate this whole vertical automatically with the `basalt` CLI:

```bash
pnpm basalt make:resource Note --prisma
```

### Database per tenant

For hard isolation, give each tenant its **own database** instead of a shared
one with a `tenantId` column — the domain code is identical:

```ts
prismaPlugin({
  forTenant: (id) => new PrismaClient({ datasourceUrl: `${env.DATABASE_URL}/${id}` }),
})
```

An LRU pool keeps connection counts bounded. Run migrations across every tenant:

```ts
import { migrateTenants } from '@basaltkit/prisma'
await migrateTenants({ tenants: await listTenantIds(), target: { mode: 'database', urlFor: (id) => `${env.DATABASE_URL}/${id}` } })
```

See [Going to Production → Persistence](/guide/production#persistence) for the
three tenancy strategies (shared / schema-per-tenant / database-per-tenant).

## 13. Going to production: Redis

Three places benefit from Redis. All are one-line swaps.

**a. The note quota** — back the subscriptions usage store with Redis so the
atomic check-and-increment works across instances:

```ts
import { Redis } from 'ioredis'
import { RedisUsageStore } from '@basaltkit/subscriptions'

const redis = new Redis(env.REDIS_URL!)
subscriptionsPlugin({ plans, fallbackPlan: 'basic', store: subStore, usage: new RedisUsageStore(redis) })
```

**b. Cache** — memoize reads (e.g. the admin dashboard) with a Redis cache:

```ts
import { cachePlugin, CACHE } from '@basaltkit/cache'

cachePlugin({ driver: 'redis', url: env.REDIS_URL })

// in a service:
const dashboard = await cache.remember('admin:dashboard', '30s', () => this.build())
```

**c. Background jobs** — send a welcome email off `note.created` without blocking
the request, via a BullMQ (Redis) queue:

```ts
import { queuePlugin, defineJob, QUEUE } from '@basaltkit/queue'

const SendWelcome = defineJob('welcome', z.object({ email: z.string() }), async ({ email }) => {
  await mailer.send({ to: email, subject: 'Welcome!' })
})

queuePlugin({ connection: env.REDIS_URL, jobs: [SendWelcome], workers: [{ queue: 'welcome', concurrency: 5 }] })

// dispatch from a domain-event listener (in your plugin's boot):
bus.on('note.created', () => void container.get(QUEUE).dispatch(SendWelcome, { email }))
```

Without a `connection`, the queue runs **synchronously** — so tests and local
dev need no Redis at all.

## 14. Harden the edge

The framework-neutral edge plugins add production concerns without touching your
routes ([Security](/guide/security), [Observability](/guide/observability)):

```ts
import { securityPlugin, healthPlugin, metricsPlugin, tracingPlugin } from '@basaltkit/fastify'

securityPlugin({ rateLimit: { limit: 300, windowMs: 60_000 }, cors: { origin: env.WEB_ORIGIN }, headers: true }),
healthPlugin({ checks: { db: () => ({ ok: prisma != null }), redis: async () => ({ ok: (await redis.ping()) === 'PONG' }) } }),
metricsPlugin(),   // Prometheus /metrics
tracingPlugin(),   // W3C trace-context + OTLP
```

Auth already throttles brute-force logins, and `POST` can be made idempotent with
`idempotencyPlugin()`.

## 15. The web app

A React + shadcn/ui frontend (type-safe via `@basaltkit/sdk`) gives the operator a
**dashboard + create-tenant** console and each tenant a **workspace** to consume
their notes — see the `web/` folder of the reference `notes` app. It's the same
routes you built here, consumed through a generated client; the Vite dev server
proxies `/api` to the backend (no CORS). See [HTTP Adapters](/guide/adapters)
for serving on Express or Hono instead of Fastify.

## 16. Test it end to end

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

Everything runs on in-memory stores, so the whole suite passes with **no
database or Redis** — swap them in only for production. That's the point: the
domain code you wrote in steps 3–9 never changes.
