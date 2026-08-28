# Introduction

Basalt is a batteries-included, modular framework for building SaaS applications on
Node.js. It is not another HTTP framework — Fastify already does that well. It
fills the layer between the server and a finished SaaS product: **tenancy,
billing, auth, permissions, audit, queues, notifications** — integrated with
an end-to-end coherence rare on Node.js, and TypeScript inference from the route
to the client.

:::tip Try it in the browser
No local setup needed — boot a runnable Basalt server in a StackBlitz WebContainer:

<StackBlitz label="Run the playground in StackBlitz" />
:::

## Why Basalt

- **Self-hosted, no lock-in.** Your data lives in your PostgreSQL, your users
  authenticate against your database. Gateways like Stripe are drivers, not
  owners of your state.
- **Multi-tenancy as a first-class citizen.** Unlike most Node stacks where
  tenancy is bolted on, the tenant context permeates cache, storage, queue,
  logger and Prisma natively through `AsyncLocalStorage`.
- **Convention over configuration.** A Basalt app runs with zero config;
  everything is overridable.
- **Incremental adoption.** Every package works on its own in an existing
  Fastify app. The full framework is the destination, not the toll to enter.

## The 30-second tour

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY, route } from '@basaltkit/fastify'
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

::: tip Not on Fastify?
The same `route` runs unchanged on **Express** and **Hono** — swap
`fastifyPlugin` for `expressPlugin` or `honoPlugin`. See
[HTTP Adapters](/guide/adapters) for complete examples.
:::

## Zero to running

The fastest path from nothing to a typed, authenticated API is the project
scaffolder. It writes a production-shaped app and includes only what you pick —
nothing dead ships.

### 1. Scaffold

```bash
pnpm create basalt my-saas       # or: npm create basalt my-saas
```

Run it with no name to answer prompts interactively, or pass flags to skip them:

```bash
pnpm create basalt my-saas --billing --cli   # add subscriptions + the `basalt` CLI
pnpm create basalt my-saas -y                 # accept every default, no prompts
```

Multi-tenancy and authentication are **on by default** — opt out with
`--no-tenancy` / `--no-auth`. In an interactive terminal the scaffolder also
installs dependencies and initializes git by default (opt out with
`--no-install` / `--no-git`); in CI or piped runs it skips both unless you pass
`--install` / `--git`. The full flag list lives in
[Installation](/guide/installation).

### 2. Install and configure

```bash
cd my-saas
pnpm install
cp .env.example .env
```

The generated `.env` holds `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` and — with
auth — an `APP_SECRET` (validated by `src/env.ts` with `@basaltkit/env`). It
ships a development default; set your own before production, and note that auth
requires a secret of **at least 16 characters**.

### 3. Run

```bash
pnpm dev        # API on http://localhost:3000
```

`src/server.ts` boots the app, resolves the Fastify instance and listens — and
shuts down cleanly on `SIGINT`/`SIGTERM`.

### 4. First requests

Every generated app exposes a friendly index and a health check:

```bash
curl http://localhost:3000/
# { "name": "my-saas", "status": "ok", "endpoints": ["GET /", "GET /health", ...] }

curl http://localhost:3000/health
# { "ok": true, "requestId": "…", "tenant": null }
```

With auth on (the default), the `/auth/*` routes are already wired. Register, log
in, then call an authenticated route with the returned token:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
# → { "user": {…}, "accessToken": "…", "refreshToken": "…" }

curl http://localhost:3000/auth/me \
  -H 'authorization: Bearer <accessToken>'
# → the authenticated user
```

Run the included smoke test to confirm everything is wired:

```bash
pnpm test
```

## Add a durable store

The scaffold boots on **in-memory stores** — perfect for dev and CI, but they
forget everything on restart. Every store in Basalt is an interface with an
in-memory default, so going durable is a swap, not a rewrite.

Open `src/app.ts`: `authPlugin` is configured with a `MemoryUserSource`. Swap it
for a durable set of stores backed by Node's built-in SQLite — no ORM, no
migration tool, no external service:

```bash
pnpm add @basaltkit/auth-sqlite
```

```ts
// src/app.ts
import { authPlugin, authRoutes, mfaRoutes } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'
import { env } from './env.js'

const stores = sqliteAuthStores('./data/auth.db') // ':memory:' by default

authPlugin({
  secret: env.APP_SECRET,
  users: stores.users,
  sessions: stores.sessions,
  refreshTokens: stores.refreshTokens,
  tokens: stores.tokens, // email verification + password reset
  mfa: stores.mfa,
})
```

Now users survive a restart. The same pattern swaps any in-memory store for a
durable one — see [Persistence & durable stores](/guide/persistence) for the
full map (SQLite and Prisma backends for auth, teams, audit, tenancy and more).

## Where to next

- [Installation](/guide/installation) — package managers, requirements, and
  adding Basalt to an existing app.
- [Core Concepts](/guide/concepts) — plugins, the DI container, request context
  and hooks.
- [HTTP Adapters](/guide/adapters) — the same routes on Fastify, Express or Hono.
- [Web UI & components](/guide/web-ui) — a type-safe SDK and admin tables/forms.
- [Build a notes SaaS](/cookbook/notes-saas) — a complete end-to-end walkthrough.
