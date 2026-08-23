# Migrating from Express

You don't have to rewrite your app to adopt Basalt, and you don't have to leave
Express. Basalt runs **on** Express (`@basaltkit/express`), so you can migrate
one route at a time — or never fully switch adapters at all.

This guide covers both paths:

1. **Incremental (recommended)** — keep your existing Express app running and let
   Basalt mount new routes on top of it. Migrate handlers when you touch them.
2. **Full** — port routes to `route()` and, optionally, swap the adapter to
   Fastify or Hono for the throughput in the [benchmarks](./benchmarks).

## The core shift

Express couples the handler to `(req, res)` and to Express itself. Basalt
describes a route as **data** — method, url, typed schemas, a pure-ish handler —
and an adapter binds it to a server. The same `route()` runs on Express, Fastify
or Hono unchanged.

```ts
// Express
app.post('/users', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })
  const user = await db.users.create({ data: { email } })
  res.status(201).json(user)
})

// Basalt — validation is declarative, the reply is the return value
import { route } from '@basaltkit/http'
import { z } from 'zod'

export const createUser = route({
  method: 'POST',
  url: '/users',
  body: z.object({ email: z.string().email() }),   // 400 on mismatch, automatically
  async handler({ body, reply }) {
    const user = await db.users.create({ data: { email: body.email } })
    return reply.code(201).send(user)   // or just `return user` for 200
  },
})
```

## Path 1 — Incremental (strangler)

`expressPlugin({ app })` takes **your** Express app. Everything already mounted on
it keeps working; Basalt adds its routes, DI container, plugins and edge
middleware alongside.

```ts
import express from 'express'
import { createApp } from '@basaltkit/core'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { securityPlugin } from '@basaltkit/http'
import { createUser } from './routes/users.js'

// 1. Your existing app — untouched
const legacy = express()
legacy.use(existingAuthMiddleware)
legacy.get('/legacy/thing', legacyHandler)

// 2. Hand it to Basalt
const app = await createApp({
  plugins: [
    securityPlugin({ cors: { origin: true } }),
    expressPlugin({ app: legacy, routes: [createUser] }),
  ],
}).boot()

// 3. One server, both worlds
app.container.get(EXPRESS).listen(3000)
```

Now `/legacy/thing` runs the old handler and `/users` runs the Basalt route.
Move endpoints across as you go; delete the Express handler once its `route()`
replacement is live. Nothing forces a big-bang rewrite.

## Path 2 — Full migration mapping

### Routing

| Express | Basalt |
| --- | --- |
| `app.get('/x', h)` | `route({ method: 'GET', url: '/x', handler })` |
| `req.params.id` | `params: z.object({ id: z.string() })` → `handler({ params })` |
| `req.query.q` | `query: z.object({ q: z.string() })` → `handler({ query })` |
| `req.body` | `body: z.object({...})` → `handler({ body })` |
| `res.json(x)` | `return x` (the return value is the body) |
| `res.status(201).json(x)` | `return reply.code(201).send(x)` |
| `res.status(204).end()` | `return reply.code(204).send()` |
| `res.set('X', v)` | `return reply.header('X', v).send(x)` |

### Validation

Drop manual `if (!req.body.email) return res.status(400)` checks — declare a Zod
schema and Basalt returns a structured `400` before your handler runs. The
handler receives fully typed, parsed input.

### Middleware → plugins, enrichers, guards

| Express pattern | Basalt equivalent |
| --- | --- |
| `app.use(helmet()); app.use(cors())` | `securityPlugin({ cors, ... })` |
| `app.use(morgan())` / metrics | `metricsPlugin()` + `loggerPlugin()` |
| `app.use(authMiddleware)` | `authPlugin({...})` + `meta: { auth: true }` on the route |
| `req.user = ...` in middleware | a **request enricher** (`http:enrichers`) → `context.user` |
| `app.use(rateLimiter)` | a **guard** (`http:guards`) that rejects before the handler |
| `app.use(errorHandler)` | throw `HttpError(status, code, message)`; the adapter formats it |

Guards and enrichers live in neutral metadata buckets, so they apply on **any**
adapter — the same auth/rate-limit logic protects your routes whether you stay on
Express or move to Fastify.

### Auth

```ts
// Express: hand-rolled JWT middleware on every protected router
router.use(requireAuth)

// Basalt: one plugin + a per-route flag; context.user is typed and populated
authPlugin({ users, secret, hasher })
route({ method: 'GET', url: '/me', meta: { auth: true },
  async handler({ context }) { return context.user } })
```

### Errors

```ts
// Express
if (!user) return res.status(404).json({ error: 'not found' })

// Basalt — throw; the adapter renders a consistent error envelope
import { HttpError } from '@basaltkit/http'
if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found')
```

## Should you switch adapters?

You don't have to. If you stay on `expressPlugin`, you gain the container,
plugins, validation and the whole `@basaltkit/*` ecosystem while keeping Express'
middleware compatibility. If you later want more throughput, switch to
`fastifyPlugin` — **your `route()` definitions don't change** (see the
[benchmarks](./benchmarks): Basalt on Fastify keeps ~90–95% of raw Fastify).

## Checklist

- [ ] `pnpm add @basaltkit/core @basaltkit/express @basaltkit/http zod`
- [ ] Wrap your existing app: `expressPlugin({ app: legacyApp })`
- [ ] Replace `app.use(cors/helmet)` with `securityPlugin`
- [ ] Move one router to `route()` with Zod schemas; delete its Express handler
- [ ] Replace auth middleware with `authPlugin` + `meta: { auth: true }`
- [ ] Convert `res.status(4xx)` early-returns to `throw new HttpError(...)`
- [ ] Repeat per router; when the last legacy handler is gone, drop the `app` option
- [ ] (Optional) swap `expressPlugin` → `fastifyPlugin`; routes stay identical
