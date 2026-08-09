# Installation

## Scaffold a new app

The fastest way to start is the project scaffolder. It generates a
production-shaped app and only includes what you pick — nothing dead ships.

```bash
npx create-basalt my-saas
```

Flags let you shape the stack:

```bash
npx create-basalt my-saas --no-tenancy   # skip multi-tenancy
npx create-basalt my-saas --no-auth      # skip authentication
npx create-basalt my-saas --billing      # include subscriptions
```

Then:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000/health
pnpm test
```

The generated project boots an app with typed routes, structured logging, a
health check and — unless you opted out — multi-tenancy (header and subdomain
resolvers) and authentication.

## Choose an HTTP adapter

Your routes are written once and run on any of three adapters — pick the one for
your stack (see [HTTP Adapters](/guide/adapters)):

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify fastify          # Fastify
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express          # Express
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server  # Hono
```

## Add to an existing app

Basalt packages work incrementally. To add multi-tenancy to an existing app,
install just the pieces you need — it works the same on any adapter:

```bash
pnpm add @basaltkit/core @basaltkit/tenancy
```

Every package publishes ESM with types and follows the same plugin contract, so
you adopt one capability at a time.

## Requirements

- **Node.js 22+**
- **pnpm** (recommended) — the monorepo pins its version via `packageManager`
- For production: **PostgreSQL** (Prisma), and **Redis** for cache/queues when
  you enable them

## Scaffold inside a project

Once you have an app, generate full resource verticals with the CLI generator:

```bash
basalt make:resource Project
```

This emits a schema, repository, service, DI plugin, typed CRUD routes and a
test — all wired and ready to run.
