# Installation

## Scaffold a new app

The fastest way to start is the project scaffolder, `create-basalt`. It
generates a production-shaped app and only includes what you pick — nothing dead
ships. Your package manager's `create` command downloads and runs it on the
spot — nothing to install first:

```bash
pnpm create basalt my-saas
# or
npm create basalt my-saas
# or
yarn create basalt my-saas
# or
bun create basalt my-saas
```

Run it **without a name** in a terminal to answer prompts interactively
(multi-tenancy, auth, billing, web UI, CLI, install, git). Pass flags to skip
the questions:

| Flag | Default | What it does |
| --- | --- | --- |
| `--no-tenancy` | tenancy **on** | Skip multi-tenancy (`@basaltkit/tenancy`) |
| `--no-auth` | auth **on** | Skip authentication (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`) |
| `--billing` | off | Include subscriptions/plans (`@basaltkit/subscriptions`) |
| `--ui` | off | Add a React + shadcn `web/` frontend — see [Web UI](/guide/web-ui). Forces pnpm |
| `--cli` | off | Add the `basalt` CLI (`make:*` generators + built-in commands) |
| `--install` / `--no-install` | on in a TTY, off in CI | Install dependencies at the end |
| `--git` / `--no-git` | on in a TTY, off in CI | `git init` + an initial commit |
| `--pm=<mgr>` | autodetect | Force `pnpm` \| `npm` \| `yarn` \| `bun` |
| `--dir=<path>` | `./<name>` | Destination folder |
| `-y`, `--yes` | — | Accept all defaults, no prompts |

```bash
pnpm create basalt my-saas --billing --cli --install --git   # full stack, installed and committed
npm create basalt service-api --no-tenancy --no-auth         # minimal API
```

In an interactive terminal the scaffolder installs dependencies and runs
`git init` by default (`--no-install` / `--no-git` to opt out); in CI or piped
runs it only writes files unless you pass `--install` / `--git`. The usual next
steps are:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000  (health check at /health)
pnpm test
```

The generated project boots an app with typed routes, structured logging, a
health check and — unless you opted out — multi-tenancy (header and subdomain
resolvers) and authentication. For a guided end-to-end run, see
[Getting Started](/guide/getting-started).

::: warning `--ui` requires pnpm
The `web/` frontend is a member of a pnpm workspace (`pnpm-workspace.yaml`), which
npm, yarn and bun can't install or run. If you request `--ui` with another
manager, the scaffolder switches to pnpm automatically.
:::

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
basalt make:resource Project                       # in-memory repository
basalt make:resource Project --prisma              # Prisma-backed + a schema.prisma model
basalt make:resource Project --prisma --soft-delete # + a deletedAt column & restore
```

This emits a schema, repository, service, DI plugin, typed CRUD routes and a
test — all wired and ready to run. Models get **`createdAt` + `updatedAt`**
automatically. **`--soft-delete`** adds a `deletedAt` column (so `delete` marks
the row instead of removing it, and `list`/`find` skip soft-deleted rows), a
`restore()` method, and a `POST /projects/:id/restore` route.
