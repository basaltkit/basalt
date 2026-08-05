# Installation

## Scaffold a new app

The fastest way to start is the project scaffolder. It generates a
production-shaped app and only includes what you pick — nothing dead ships.

```bash
npx create-machize my-saas
```

Flags let you shape the stack:

```bash
npx create-machize my-saas --no-tenancy   # skip multi-tenancy
npx create-machize my-saas --no-auth      # skip authentication
npx create-machize my-saas --billing      # include subscriptions
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

## Add to an existing app

Machize packages work incrementally. To add multi-tenancy to an existing
Fastify app, install just the pieces you need:

```bash
pnpm add @machize/core @machize/fastify @machize/tenancy
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
mach make:resource Project
```

This emits a schema, repository, service, DI plugin, typed CRUD routes and a
test — all wired and ready to run.
