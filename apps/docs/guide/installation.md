# Installation

There are two ways in. `create-basalt` scaffolds a production-shaped app in one
command and only writes the features you pick — nothing dead ships. Or you add
individual `@basaltkit/*` packages to an app you already have: every package is
ESM with types, follows the same plugin contract, and works on its own. This
page covers both, plus the `basalt` CLI that generates code once you're inside a
project.

[[toc]]

## Requirements

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | **22 or newer** (`engines: >=22`) | The framework targets modern Node; CI runs the whole monorepo on 22 and 24 |
| Package manager | pnpm (recommended), npm, yarn or bun | Only `--ui` is pnpm-only — it scaffolds a pnpm workspace |
| Node 22.5+ | for `node:sqlite` | The zero-dependency `*-sqlite` stores (`auth-sqlite`, `teams-sqlite`, …) use Node's built-in SQLite |
| Node 22.6+ | for `basalt dev` without `tsx` | The dev runner falls back to `node --watch --experimental-strip-types` when `tsx` isn't installed |
| PostgreSQL / Redis | production only | Prisma-backed stores need Postgres or MySQL; BullMQ queues and the Redis cache driver need Redis |

Nothing beyond Node is required to *start* — the scaffold boots on in-memory
stores. See [Persistence & durable stores](/guide/persistence) for the swap.

## Scaffold a new app

Your package manager's `create` command downloads and runs the scaffolder on the
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

Run it **with no name** in a terminal and you get the interactive wizard
instead. Pass flags (or `-y`) to skip every question.

### The interactive wizard

The wizard runs only when you gave no name, stdin is a TTY, and you didn't pass
`--yes` — so CI and piped runs always take the flag-driven path. It asks, in
order:

1. **Project name** — defaults to `my-saas`, validated as an installable npm
   package name (lowercase, no spaces, max 214 characters, optional `@scope/`).
2. **Choose a starting point** — one of the presets below.
3. **Select features** — only for the `custom` preset; multi-select with
   tenancy and auth pre-ticked.
4. **Package manager** — pnpm / npm / yarn / bun, defaulting to the one that
   invoked the command.
5. **Install dependencies now?** and **Initialize a git repository?** — both
   default to yes.
6. A summary, then **Create project?** — answering no (or Ctrl+C) prints
   `Cancelled.` and exits with code 130, writing nothing.

### Presets

| Preset | Features |
| --- | --- |
| **SaaS starter** | tenancy + auth + billing + CLI |
| **API only** | auth + MCP — no tenancy, no UI |
| **Full stack** | everything, including the web UI |
| **Minimal** | none — add them later |
| **Custom** | you pick from the feature list |

## Scaffolder flags

| Flag | Default | What it does |
| --- | --- | --- |
| `<name>` (positional) | — | Project name and, unless `--dir` says otherwise, the target folder |
| `--dir=<path>` | `./<name>` | Destination folder |
| `--no-tenancy` | tenancy **on** | Skip multi-tenancy (`@basaltkit/tenancy`, header + subdomain resolvers) |
| `--no-auth` | auth **on** | Skip authentication (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`, `mfaRoutes()`) |
| `--billing` | off | Include subscriptions and plans (`@basaltkit/subscriptions`) |
| `--ui` | off | Add a React + shadcn `web/` frontend — see [Web UI](/guide/web-ui). **Forces pnpm** |
| `--cli` | off | Add `bin/basalt.ts`, the `basalt` script, generators and `prisma:sync` |
| `--mcp` | off | Expose opted-in read-only routes as MCP tools at `POST /mcp`, plus a `.mcp.json` for AI dev tools — see [MCP](/guide/mcp) |
| `--install` / `--no-install` | on in a TTY, off in CI | Install dependencies at the end |
| `--git` / `--no-git` | on in a TTY, off in CI | `git init` plus an initial commit |
| `--pm=<manager>` | auto-detected | Force `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Accept all defaults, no prompts (also disables the wizard) |
| `-h`, `--help` | — | Print usage and exit |

```bash
pnpm create basalt my-saas --billing --cli --install --git   # full stack, installed and committed
npm create basalt service-api --no-tenancy --no-auth         # minimal API
pnpm create basalt agent-api --mcp -y                        # API + MCP tools, no prompts
```

The package manager is detected from `npm_config_user_agent` (the variable npm,
pnpm, yarn and bun all set), falling back to npm. `--install` and `--git` are
tri-state: an explicit flag always wins, and only when you pass neither does the
environment decide — a TTY that isn't CI gets both, everything else gets
neither, so automation never gets a surprise install.

::: warning `--ui` requires pnpm
The `web/` frontend is a member of a pnpm workspace (`pnpm-workspace.yaml`),
which npm, yarn and bun can't install or run. Ask for `--ui` with another
manager and the scaffolder tells you it is switching to pnpm, then does.
:::

## What gets generated

Every project gets the same skeleton; the feature flags only change what's
inside it:

| Path | Contents |
| --- | --- |
| `src/env.ts` | `defineEnv` over `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` (+ `APP_SECRET` via `secret({ minLength: 32 })` with auth) |
| `src/app.ts` | `buildApp()` — config, logger, events, security headers, then tenancy/auth/billing/MCP/CLI as selected |
| `src/routes.ts` | `GET /` (a friendly index) and `GET /health` |
| `src/server.ts` | Boots, resolves `FASTIFY`, listens, and shuts down on `SIGINT`/`SIGTERM` |
| `tests/app.test.ts` | A smoke test that boots the app and hits `/` and `/health` |
| `package.json` | Scripts `dev` (`tsx watch src/server.ts`), `start`, `test`, `typecheck` — plus `basalt` with `--cli` |
| `.env.example`, `.gitignore`, `README.md`, `tsconfig.json`, `pnpm-workspace.yaml` | Project scaffolding |
| `bin/basalt.ts` | With `--cli`: the CLI entrypoint wiring the generators and `prisma:sync` |
| `.mcp.json` | With `--mcp`: registers the **dev-only** `basalt-ai-mcp` bridge for MCP clients |
| `web/…` | With `--ui`: the React + shadcn frontend, a pnpm workspace member |

Then the usual next steps:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000  (health check at /health)
pnpm test
```

For a guided end-to-end run, see [Getting Started](/guide/getting-started).

## Choose an HTTP adapter

Routes are written once and run on any of three adapters — pick the one for your
stack (see [HTTP Adapters](/guide/adapters)):

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify fastify          # Fastify
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express          # Express
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server  # Hono
```

The scaffolder always writes Fastify; swapping later is a one-line change,
because `route()` and the guards live in the neutral `@basaltkit/http`
contract.

## Add to an existing app

Basalt packages adopt incrementally. To add multi-tenancy to an app you already
have, install just those pieces — it works the same on any adapter:

```bash
pnpm add @basaltkit/core @basaltkit/tenancy
```

The full catalogue is in the [package reference](/reference/packages), and
[Migrating from Express](/guide/migrating-from-express) walks through adopting
the framework a capability at a time.

## Scaffold inside a project

With `--cli` (or after adding `@basaltkit/cli` + `@basaltkit/generator`
yourself), `pnpm basalt` generates whole resource verticals:

```bash
pnpm basalt make:resource Project                        # in-memory repository
pnpm basalt make:resource Project --prisma               # Prisma-backed + a schema.prisma model
pnpm basalt make:resource Project --prisma --soft-delete # + a deletedAt column & restore
pnpm basalt make:service Project                         # just one artifact
```

`make:resource` emits a schema, repository, service, DI plugin, typed CRUD
routes and a test into `src/modules/<name>/`, then **wires the plugin and routes
into `src/app.ts` for you**. Models get `createdAt` + `updatedAt` automatically.
`--soft-delete` adds a `deletedAt` column (so `delete` marks the row instead of
removing it, and `list`/`find` skip soft-deleted rows), a `restore()` method,
and a `POST /projects/:id/restore` route.

| Generator flag | Applies to | What it does |
| --- | --- | --- |
| `--prisma` | `make:resource`, `make:repository` | Prisma-backed repository plus a model appended to `schema.prisma` |
| `--soft-delete` | `make:resource` and the artifacts it builds | `deletedAt` column, `restore()`, restore route, filtered reads |
| `--dir=<path>` | all `make:*` | Target root (default: the current directory) |
| `--force` | all `make:*` | Overwrite existing files instead of refusing |
| `--no-register` | `make:resource` | Skip the automatic wiring into `src/app.ts` |

Individual artifacts are available as `make:schema`, `make:repository`,
`make:service`, `make:plugin`, `make:routes` and `make:test`.

### Built-in CLI commands

`runCli` always offers these, alongside anything a plugin registers:

| Command | What it does |
| --- | --- |
| `list` (or no command) | Print every available command |
| `routes` | The registered HTTP routes, read from the `http:routes` metadata bucket |
| `schedule:list` | Scheduled tasks with their cron expressions and timezones |
| `dev` | Print the route table, then run the app with watch/restart. `--entry=<file>`, `--worker` (`-w`) to start a queue worker alongside, `--queue=<name>` |
| `upgrade` | Apply framework upgrade codemods. `--dry` to preview, `--only=<id>`, `--dir=<path>` |
| `publish` | Copy a stub group into the app (`dockerfile`, `ci`, `editorconfig`). Run with no id to list; `--force` to overwrite |

Registering `queuePlugin` adds `queue:work`, `queue:stats` and `queue:retry` —
see [Queues & jobs](/guide/queues).

## Failure modes & troubleshooting

| Error | Exit code | When |
| --- | --- | --- |
| `TargetNotEmptyError` — "Target directory … already exists and is not empty" | 1 | The destination has files. Pick another name or `--dir=` |
| `Cancelled.` (`WizardCancelledError`) | 130 | Ctrl+C, or answering no to "Create project?". Nothing is written |
| `FileExistsError` — "Refusing to overwrite existing files" | 1 | A `make:*` target already exists. Re-run with `--force` |
| `Unknown command "…". Run "basalt list" to see what is available.` | 1 | Typo, or the plugin that registers the command isn't in `buildApp` |
| `No entry file found. Looked for src/main.ts, src/server.ts, …` | 1 | `basalt dev` in a project with a different entrypoint — pass `--entry=<file>` |

- **The scaffolder ignored my flags** — some package managers keep everything
  after the package name for themselves. Put the flags after `--`:
  `npm create basalt my-saas -- --billing --cli`. pnpm and bun forward them
  directly.
- **"Skipping dependency install (CI/non-interactive)"** — expected: without an
  explicit flag, only an interactive non-CI terminal installs. Pass `--install`
  (and `--git`) to force it.
- **`--ui` silently became pnpm** — it has to; the `web/` package is a pnpm
  workspace member. Start the frontend with
  `pnpm --filter <name>-web dev` (port 5180) while `pnpm dev` serves the API on
  3000.
- **"Could not auto-wire src/app.ts"** — `make:resource` only edits an
  `app.ts` that still uses `fastifyPlugin({ routes: [...] })`. Add the generated
  plugin to `plugins` and the routes to the adapter yourself; the generated
  files are otherwise complete.
- **`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, or `--experimental-strip-types`
  is rejected** — you're on a Node older than 22.5 / 22.6. Upgrade Node, or
  install `tsx` (which the scaffold already does).

## Where to next

- [Getting Started](/guide/getting-started) — the guided run through the
  generated app.
- [Configuration](/guide/config) — `src/env.ts`, secrets and the settings
  repository.
- [Core Concepts](/guide/concepts) — plugins, the container and request context.
- [Testing](/guide/testing) — `createTestApp` and the fakes shipped in
  `devDependencies`.
- [Production](/guide/production) — durable stores, Docker and the deploy
  checklist.
