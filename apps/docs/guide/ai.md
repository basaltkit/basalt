# AI-assisted development

`@basaltkit/ai` is a **development-time** tool: a `basalt ai` CLI that understands
your Basalt project and helps you analyze, diagnose, plan and generate features —
always through the framework's own conventions.

::: tip The AI generates code; the framework defines the architecture.
`@basaltkit/ai` is **never a runtime dependency**. Your SaaS runs completely
without it, and generated code imports the official packages (Prisma, tenancy,
permissions, audit…) — never `@basaltkit/ai`. It's a tool that *uses* the
architecture, it doesn't invent one.
:::

[[toc]]

## Install (dev-only)

`create-basalt --cli` wires this for you. To add it to an existing app, install it
as a **devDependency**:

```bash
pnpm add -D @basaltkit/ai
```

Register the commands in `bin/basalt.ts` (the CLI entry) — **not** in `app.ts` — so
the runtime server never imports the dev tools:

```ts
// bin/basalt.ts
import { runCli } from '@basaltkit/cli'
import { generatorCommands } from '@basaltkit/generator'
import { aiCommands } from '@basaltkit/ai'
import { prismaSyncCommand } from '@basaltkit/prisma'
import { buildApp } from '../src/app.js'

// buildApp takes the dev/CLI commands only here; src/server.ts omits them.
const app = buildApp({ commands: [...generatorCommands(), ...aiCommands(), prismaSyncCommand()] })
process.exit(await runCli({ app }))
```

## Choose a provider

The AI is vendor-agnostic (`AI_PROVIDER`). The read-only commands (`ai:analyze`,
`ai:doctor`, `ai:fix`) run offline with no provider; `ai:plan`, `ai:make` and
`--review` call a model.

```bash
# Anthropic (default)
export AI_PROVIDER=anthropic AI_API_KEY=sk-…

# Any OpenAI-compatible gateway (OpenAI, LiteLLM, OpenRouter, go4ai, …)
export AI_PROVIDER=openai AI_BASE_URL=https://your-gateway/v1 AI_API_KEY=… AI_MODEL=…

# Local Ollama (no key)
export AI_PROVIDER=ollama AI_MODEL=llama3.1
```

## Commands

| Command | What it does | Model? |
| --- | --- | --- |
| `basalt ai` | Overview: detected stack + available commands | no |
| `basalt ai:analyze` | Stack, data model and diagnostics report | no |
| `basalt ai:doctor` | Diagnostics with suggested fixes (exits non-zero on errors) | no |
| `basalt ai:fix [id]` | Apply a doctor fix (or all auto-fixable ones) | no |
| `basalt ai:plan "…"` | Natural language → architecture plan | yes |
| `basalt ai:make "…"` | Plan **and** implement a feature | yes |

### `ai:analyze` — understand the project

Read-only. Detects the wired stack (Fastify, Prisma, tenancy, auth, RBAC,
subscriptions, queue, search…), the Prisma data model with tenant-scoping, and a
diagnostics summary.

### `ai:doctor` / `ai:fix` — diagnose and fix

`ai:doctor` runs an offline rules engine — insecure `APP_SECRET`, database not
validated at boot, Fastify logger off, tenant-scoped models missing `tenantId`,
non-durable in-memory sources, a localhost Redis default. It exits non-zero on an
error, so you can gate CI on it.

`ai:fix <id>` applies the fix for a rule (or `ai:fix` for every auto-fixable one)
with a line-level diff and a confirmation. Use `--dry-run` to preview.

### `ai:plan` — design first

Turns a description into a numbered **architecture plan** (read-only, writes
nothing). It's grounded in your actual stack and reuses the official building
blocks: `make:resource`, `tenantId` scoping, RBAC permissions and audit events.

### `ai:make` — implement

Plans, then generates a complete backend resource vertical, on-convention.

```bash
basalt ai:make "an invoices module per tenant: number, amount, issue date and status (paid/pending), linked to a client"
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Generate in memory, write nothing (great with `--review`) |
| `--yes` | Skip the confirmation prompt |
| `--migrate` / `--no-migrate` | Run `prisma db push` after generating (or skip it) |
| `--review` | An LLM **Review agent** critiques the generated code |
| `--verify` | Run the project's typecheck |

## What `ai:make` generates

A full backend vertical per entity — all through official APIs:

- **Prisma model** — `tenantId` + `@@index` when tenant-scoped, real `@relation`s
  (FK column + `@relation` + the inverse field), enum-backed `String` columns.
- **Zod schema** — typed fields, `z.enum([...])` for fixed value sets,
  `z.coerce.date()` for dates.
- **Typed routes** — RBAC `meta.can` guards and OpenAPI `summary`/`tags`.
- **Service + repository** — every query scoped by `tenantId` (a missing tenant is
  a clear `400`, never a silent `500`).
- **Permissions** — a `<name>.permissions.ts` declaring the permissions plus a
  `grant<Name>Permissions(store, role)` helper.
- **Audit** — `AUDIT.record()` wired into create/update/delete when audit is on.
- **A test.**

The model is merged into `prisma/schema.prisma`; `--migrate` (or the prompt after
generating) runs `prisma db push` to create the table and regenerate the client.

## The workflow

```bash
export AI_PROVIDER=openai AI_BASE_URL=… AI_API_KEY=… AI_MODEL=…

pnpm basalt ai:make "an invoices module per tenant: number, amount, issue date and status (paid/pending), linked to a client"
# 1. review the plan → confirm
# 2. answer 'y' to run `prisma db push`
# 3. restart the dev server so it loads the regenerated Prisma client
```

::: warning Tenant header
Every tenant-scoped route needs the current tenant — send the `x-tenant-id`
header (matching a tenant your app resolves). Without it the route returns a `400`.
:::

## The Review agent

`--review` runs an LLM pass over the **generated code** and returns a verdict with
issues by dimension (tenancy, security, RBAC, validation, tests, fit). Any
error-severity issue blocks (the command exits non-zero); warnings don't. It
reviews the backend vertical on its own terms — it judges, it never rewrites code.

## Why dev-only matters

`@basaltkit/ai` and `@basaltkit/generator` are `devDependencies`, registered in
`bin/basalt.ts` only. `src/server.ts` (the runtime) never imports them, so a
production build runs without the AI/codegen layer entirely. Every SaaS built with
the ecosystem keeps the same, reusable architecture — the framework owns it; the AI
is a tool that speaks it.
