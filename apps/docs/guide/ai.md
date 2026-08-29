# AI-assisted development

`@basaltkit/ai` is a **development-time** package: a `basalt ai` CLI (plus the
engine behind it) that reads your project, reports what's wired, diagnoses
configuration and tenancy problems, turns a sentence into an architecture plan,
and scaffolds a complete backend vertical through the framework's own
conventions. It is decoupled from your running app: nothing in `src/server.ts`
ever imports it, and the code it writes imports the official packages only.

::: tip The AI generates code; the framework defines the architecture.
`@basaltkit/ai` is **never a runtime dependency**. Your SaaS runs completely
without it, and generated code imports the official packages (Prisma, tenancy,
permissions, audit…) — never `@basaltkit/ai`. It's a tool that *uses* the
architecture, it doesn't invent one. A test in the repo makes this mechanical —
see [Why dev-only matters](#why-dev-only-matters).
:::

[[toc]]

## Where the AI layer fits

Four packages make up Basalt's AI/MCP story. Only the last one runs in
production — this page is the first row:

| Layer | Package | Role | Runtime? |
| --- | --- | --- | --- |
| Intelligence | **`@basaltkit/ai`** | **This page** — the `basalt ai` CLI, providers, the analyze/doctor/plan/make/review engine | dev-only |
| Dev bridge | [`@basaltkit/ai-mcp`](/guide/ai-mcp) | Exposes those same workflows to your editor over MCP | dev-only |
| Wire | [`@basaltkit/mcp-core`](/guide/mcp-core) | Zero-dependency MCP protocol + generic server + transports | shared |
| Runtime surface | [`@basaltkit/mcp`](/guide/mcp) | Your app's opt-in routes become tools for agents, in production | runtime |

The mental model in one line: **`ai` is the brain, `ai-mcp` is the cable to your
editor, `mcp-core` is the wire, `mcp` is what your product ships.**

Within `@basaltkit/ai` itself there are two halves. The **offline** half
(`ai:analyze`, `ai:doctor`, `ai:fix`) is a deterministic rules engine over your
source files — no network, no key, safe in CI. The **model-backed** half
(`ai:plan`, `ai:make`, `--review`) calls an LLM through a provider you choose.
Nothing in either half touches your database except the explicitly gated
`prisma db push`.

## Install (dev-only)

`create-basalt --cli` wires this for you. To add it to an existing app, install
it as a **devDependency**:

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

`aiCommands({ cwd })` optionally pins the project root the commands analyze;
otherwise they use `process.cwd()`, and every command accepts `--dir=<path>` to
override it per invocation.

## Choose a provider

The engine never talks to a vendor SDK — every command depends on the
`AIProvider` interface, so switching vendors is an environment change, not a code
change. `AI_PROVIDER` selects it (default `anthropic`):

```bash
# Anthropic (default) — model defaults to claude-sonnet-5
export AI_PROVIDER=anthropic AI_API_KEY=sk-…

# Any OpenAI-compatible gateway (OpenAI, LiteLLM, OpenRouter, go4ai, …)
export AI_PROVIDER=openai AI_BASE_URL=https://your-gateway/v1 AI_API_KEY=… AI_MODEL=…

# Local Ollama (no key)
export AI_PROVIDER=ollama AI_MODEL=llama3.1
```

| `AI_PROVIDER` | Class | Default model | Default base URL | Key required |
| --- | --- | --- | --- | --- |
| `anthropic` *(default)* | `AnthropicProvider` | `claude-sonnet-5` | `https://api.anthropic.com` | yes (`AI_API_KEY`) |
| `openai` · `openai-compatible` | `OpenAICompatibleProvider` | `gpt-4o-mini` | `https://api.openai.com/v1` | yes (`AI_API_KEY`) |
| `ollama` | `OllamaProvider` | `llama3.1` | `http://localhost:11434` | no |

`google` is a recognised name that deliberately **throws** — it isn't
implemented. Any other value throws `createProvider: unknown AI_PROVIDER=…`.

::: tip Gateways, streaming and transient 5xx
The OpenAI-compatible provider streams by default (SSE) — set `AI_STREAM=false`
for a gateway that can't stream. Every provider request goes through
`fetchWithRetry`, which retries `429` and `5xx` responses plus network errors
twice with exponential backoff (300 ms, then 600 ms). A **cancelled** request is
never retried. Some gateways return a spurious `500` when buffering a long
non-streaming response; the retry usually clears it.
:::

## Commands

| Command | What it does | Needs a model? | Writes? | Exit code |
| --- | --- | --- | --- | --- |
| `basalt ai` | Overview: detected stack + available commands | no | no | always `0` |
| `basalt ai:analyze` | Stack, data model and diagnostics report | no | no | always `0` |
| `basalt ai:doctor` | Diagnostics only (no fixes applied) | no | no | `1` if any **error**-severity finding |
| `basalt ai:fix [id]` | Apply an auto-fixable diagnostic | no | **source files** | `1` only if the requested `id` has no auto-fix |
| `basalt ai:plan "…"` | Natural language → architecture plan | **yes** | no | `1` on empty request, no provider, or a bad model response |
| `basalt ai:make "…"` | Plan **and** implement a feature | **yes** | **source files** (+ opt-in DB push) | `1` if the review gate fails or any step fails |

### `basalt ai` — the overview

Runs the analysis and prints it, followed by the command list. Trailing words are
echoed back (`basalt ai "add invoices"` acknowledges the request and points you at
`ai:plan` / `ai:make`) — the overview itself never plans or writes.

### `ai:analyze` — understand the project

Read-only and offline. It detects the project by reading, from the root:
`package.json`, `prisma/schema.prisma` (or `schema.prisma`), `src/app.ts`,
`src/server.ts` and `src/env.ts` (with `.js` / alternative-path fallbacks). From
those it derives an `AnalysisReport`:

| Field | Contents |
| --- | --- |
| `capabilities` | Human-readable lines — `Fastify detected`, `Prisma detected`, `PostgreSQL detected`, `Tenancy enabled`, `Authentication enabled`, `RBAC enabled`, `Subscriptions`, `Payments`, `Queue`, `Search`, `Audit`, `Events`, `Scheduler`, `Storage` |
| `installed` | The `@basaltkit/*` packages found in `package.json` |
| `database` | `postgresql` · `mysql` · `sqlite` · `null` |
| `models` / `tenantScopedModels` / `unscopedModels` | The Prisma models, split by whether they carry a `tenantId` |
| `diagnostics` | The same findings `ai:doctor` reports |

Detection is **static** — it reads the plugin calls in `src/app.ts`, it never boots
your app, so it's safe on a project whose database is down.

### `ai:doctor` — diagnose

Runs an offline rules engine and exits non-zero when any finding is
error-severity, so you can gate CI on it (`basalt ai:doctor` in a pipeline step).
The complete rule set:

| Rule id | Severity | Category | Fires when |
| --- | --- | --- | --- |
| `insecure-app-secret` | error | security | `APP_SECRET` has a placeholder default in `src/env.ts` |
| `missing-tenant-membership` | error | tenancy | A tenant is resolved from the request but no membership guard enforces it |
| `prisma-lazy-boot` | warning | observability | The database connection isn't validated at boot |
| `fastify-logger-off` | warning | observability | `fastifyPlugin` is registered with no `logger` config |
| `missing-security-plugin` | warning | security | No `securityPlugin` — responses ship without secure headers |
| `tenant-scoping-missing` | warning | tenancy | A tenant-scoped app has Prisma models without a `tenantId` |
| `in-memory-security-store` | warning | security | Security state is kept in an in-memory store |
| `memory-sources-in-use` | info | durability | Non-durable `Memory*` sources are wired |
| `redis-localhost-default` | info | config | `REDIS_URL` defaults to localhost |

The tenancy rules are the ones worth taking seriously — see
[Tenancy](/guide/tenancy) and [Teams](/guide/teams) for the membership guard
`missing-tenant-membership` is asking for.

### `ai:fix` — apply an auto-fix

`basalt ai:fix <id>` computes the edits for one rule; `basalt ai:fix` with no id
fixes **every currently-firing rule that has an auto-fixer**. Either way you get
a line-level diff first, then a confirmation prompt (skip it with `--yes`, or
preview only with `--dry-run`).

::: warning Only two rules are auto-fixable
`fastify-logger-off` and `insecure-app-secret` have safe, precise edits. Every
other rule needs a judgement call (which durable store? which model gets a
`tenantId`?) and reports `no auto-fix — apply manually`. `ai:fix` is a
convenience for the mechanical two, not a blanket repair tool — read
`ai:doctor` and fix the rest yourself.
:::

Each target reports one of three statuses: `ready` (edits computed, will be
written), `noop` (`nothing to change (already fixed?)`), or `unfixable` (no
auto-fixer, or `target file not found`).

### `ai:plan` — design first

Turns a description into a numbered **architecture plan** — read-only, writes
nothing. The plan is grounded in your actual stack (the detected context is part
of the prompt) and in Basalt's conventions, so it reuses the official building
blocks: the `make:resource` generator, `tenantId` scoping, RBAC permissions and
audit events. Sampling is deterministic by default (`temperature: 0`,
`maxTokens: 4096`).

The result is an `ArchitecturePlan`: a `summary`, `entities` (with fields and
relations), ordered `steps`, `permissions`, `auditEvents`, `warnings`, and a
`schemaVersion`. That object is the hand-off to `ai:make` — and, over MCP, the
client carries it between the two tools.

### `ai:make` — implement

Plans first, shows you the plan, asks for confirmation, then generates a complete
backend vertical on-convention:

```bash
basalt ai:make "an invoices module per tenant: number, amount, issue date and status (paid/pending), linked to a client"
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Generate in memory, write nothing; skips both prompts (great with `--review`) |
| `--yes` | Skip the confirmation prompt — **and pre-consent to `prisma db push`** |
| `--force` | Overwrite files that already exist instead of refusing |
| `--migrate` | Run `prisma db push` after generating |
| `--no-migrate` | Suppress the "run `prisma db push` now?" prompt entirely |
| `--review` | An LLM **Review agent** critiques the generated code |
| `--verify` | Run the project's typecheck (`pnpm -s typecheck`) after generating |

::: warning `--yes` implies `--migrate`
The confirmation prompt and the migration prompt are the same consent in the
CLI's model: passing `--yes` pre-approves the write *and* runs `prisma db push`.
If you want the files but not the schema push, use `--no-migrate` alongside it,
or answer the prompts interactively.
:::

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

The model is merged into `prisma/schema.prisma` (models already present are left
alone), and the resource is auto-wired into `src/app.ts`. The step people forget
is the schema push: without it the regenerated Prisma client has no delegate for
the new model and every route 500s — which is exactly why the command offers to
run it for you.

Every build ends with a **deterministic review gate** (no model involved) that
scores the result on: *Tenant isolation* (does every tenant-scoped model carry a
`tenantId`?), *Validation & routes*, *Tests*, *Permissions*, *Audit* and
*Migration*. A `fail` on any item makes `ai:make` exit `1`.

## The workflow

```bash
export AI_PROVIDER=openai AI_BASE_URL=… AI_API_KEY=… AI_MODEL=…

pnpm basalt ai:make "an invoices module per tenant: number, amount, issue date and status (paid/pending), linked to a client"
# 1. review the plan → confirm
# 2. answer 'y' to run `prisma db push`
# 3. restart the dev server so it loads the regenerated Prisma client
```

Design-first is the safer loop, and it costs one extra command:

```bash
pnpm basalt ai:plan "…"                    # read the plan, change nothing
pnpm basalt ai:make "…" --dry-run --review # see the files + the critique
pnpm basalt ai:make "…" --verify           # write, then typecheck
```

::: warning Tenant header
Every tenant-scoped route needs the current tenant — send the `x-tenant-id`
header (matching a tenant your app resolves). Without it the route returns a `400`.
See [Tenancy](/guide/tenancy).
:::

## The Review agent

`--review` runs an LLM pass over the **generated code** and returns a verdict with
issues by dimension (tenancy, security, RBAC, validation, tests, fit). Any
error-severity issue blocks (the command exits non-zero); warnings don't. It
reviews the backend vertical on its own terms — it judges, it never rewrites code.

The review is deliberately **non-fatal when it fails to run**: if the provider
errors or the model returns unparseable JSON, you get
`Review inconclusive — <reason>` and the build is *not* blocked. A broken review
should never break your build; a review that ran and disapproved should.

## Use it from your editor (MCP)

Prefer to drive these workflows from **Claude Code** or **Claude Desktop** instead
of the terminal? [`@basaltkit/ai-mcp`](/guide/ai-mcp) is a dev-only MCP bridge that
exposes `analyze`, `doctor`, `plan`, `review` and (safe, preview-first) `make` as
MCP tools — the same engine, in your editor:

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

It reads the *same* `AI_*` environment variables, documented below.

## Options reference

### Flags — every `ai:*` command

| Flag | Type | Default | Purpose |
| --- | --- | --- | --- |
| `--dir=<path>` | string | `aiCommands({ cwd })`, else `process.cwd()` | Analyze/scaffold a project other than the current directory (monorepos, CI) |

### `basalt ai:fix [id]`

| Flag | Type | Default | Purpose |
| --- | --- | --- | --- |
| `id` (positional) | string | all firing auto-fixable rules | Fix one diagnostic instead of every fixable one |
| `--dry-run` | boolean | `false` | Print the diff and stop — nothing is written |
| `--yes` | boolean | `false` | Skip the "Apply N fix(es)?" confirmation (CI / scripted use) |

### `basalt ai:make "<request>"`

| Flag | Type | Default | Purpose |
| --- | --- | --- | --- |
| `--dry-run` | boolean | `false` | In-memory build: no writes, no prompts. The way to inspect a build before trusting it |
| `--yes` | boolean | `false` | Skip the write confirmation **and** pre-consent to `prisma db push` |
| `--force` | boolean | `false` | Overwrite existing files; without it a clash aborts with `FileExistsError` |
| `--migrate` | boolean | `false` | Run `prisma db push` right after merging the model |
| `--no-migrate` | boolean | `false` | Never offer the migration prompt — for when you manage migrations yourself |
| `--review` | boolean | `false` | Run the LLM Review agent over the generated code; an error-severity issue exits `1` |
| `--verify` | boolean | `false` | Run `pnpm -s typecheck` in the project (180 s timeout); a failure exits `1` |

### Provider configuration (environment)

Read by `createProvider(providerEnvFromProcess())` — the CLI and the MCP bridge
read exactly the same set.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `AI_PROVIDER` | `anthropic` · `openai` · `openai-compatible` · `ollama` | `anthropic` | Which vendor to call. `google` is recognised but throws (unimplemented) |
| `AI_API_KEY` | string | — | Vendor key. Required for `anthropic` and `openai`; unused by `ollama` |
| `AI_MODEL` | string | per-provider (see the provider table) | Pin a specific model id |
| `AI_BASE_URL` | string | per-provider | Point at a gateway (`https://…/v1` for OpenAI-compatible) or a non-default Ollama host |
| `AI_STREAM` | `'false'` disables | streaming on | Turn off SSE streaming for an OpenAI-compatible gateway that can't stream |

### `aiCommands(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Project root the commands analyze, when `--dir` isn't passed |

## Failure modes & troubleshooting

| Message | Raised by | Exit | When |
| --- | --- | --- | --- |
| `ai:plan needs an AI provider — …` / `ai:make needs an AI provider — …` | `commands.ts` | `1` | `createProvider` threw — no key, or an unknown `AI_PROVIDER` |
| `AnthropicProvider: apiKey is required (set AI_API_KEY)` | `AnthropicProvider` | `1` | `AI_API_KEY` is empty or unset |
| `OpenAICompatibleProvider: apiKey is required (set AI_API_KEY)` | `OpenAICompatibleProvider` | `1` | Same, for the OpenAI-compatible path |
| `createProvider: unknown AI_PROVIDER='x'. Use 'anthropic', 'ollama' or 'openai'.` | `createProvider` | `1` | Typo in `AI_PROVIDER` |
| `createProvider: 'google' is not implemented …` | `createProvider` | `1` | `AI_PROVIDER=google` — not wired |
| `AnthropicProvider: <status> — …` · `OllamaProvider: …` · `OpenAICompatibleProvider: …` | provider | `1` | The gateway returned a non-OK status after the retries were exhausted |
| `ai:plan — the model did not return valid JSON. Got: …` | `parsePlan` | `1` | The model wrapped or mangled the plan JSON |
| `ai review — the model did not return valid JSON. Got: …` | `parseReview` | *not fatal* | Surfaces as `Review inconclusive — …`; the build continues |
| `ai:make — the plan has no entity to generate.` | `runMake` | `1` | The plan came back with an empty `entities` array — rephrase the request |
| `Refusing to overwrite existing files (use force to replace): …` | `FileExistsError` (`@basaltkit/generator`) | `1` | A generated path already exists — re-run with `--force` |
| `✗ prisma db push failed: …` | `runPrismaPush` | `1` | `DATABASE_URL` unreachable, or the merged model doesn't validate |
| `Usage: basalt ai:plan "<what you want to build>"` | `commands.ts` | `1` | The request argument was empty |
| ``no auto-fix — apply manually (see `basalt ai:doctor`)`` | `planFix` | `1` (only when an `id` was given) | The rule has no auto-fixer — only two rules do |
| `target file not found` | `planFix` | `1` (only when an `id` was given) | The fix's target (`src/app.ts`, `src/env.ts`) wasn't detected — the outcome is `unfixable` |

- **Every route 500s right after `ai:make`** — the Prisma client wasn't
  regenerated. Run `npx prisma db push` and **restart the dev server**; the
  running process holds the old client.
- **`ai:doctor` is green in dev and red in CI (or vice-versa)** — the rules read
  files, not environment. A different checkout layout (no `src/app.ts`, a
  non-standard schema path) simply makes rules stop firing; run with
  `--dir=<project root>` from the repo root.
- **`ai:analyze` reports nothing enabled** — detection is static and keys off the
  plugin *calls* in `src/app.ts`. If you build the plugin list in another module,
  the detector can't see it; that's a detection gap, not a broken app.
- **The provider returns 500 on long generations** — the gateway is buffering.
  Leave streaming on, or lower `maxTokens` via `ai:plan` over MCP; `AI_STREAM=false`
  makes this *more* likely, not less.
- **`ai:make --yes` migrated when you didn't want it to** — `--yes` pre-consents to
  `prisma db push`. Add `--no-migrate`.
- **A tenant-scoped model came out without `tenantId`** — the deterministic review
  gate reports it as a `Tenant isolation` failure and exits `1`. Fix the plan (say
  "per tenant" explicitly) rather than patching the generated model.

## Why dev-only matters

`@basaltkit/ai` and `@basaltkit/generator` are `devDependencies`, registered in
`bin/basalt.ts` only. `src/server.ts` (the runtime) never imports them, so a
production build runs without the AI/codegen layer entirely.

This isn't a convention people are asked to remember — it's **tested**:

- `packages/ai-mcp/test/dev-only-guard.test.ts` walks every workspace
  `package.json` and fails if `@basaltkit/ai` or `@basaltkit/ai-mcp` appears in
  `dependencies` or `peerDependencies` anywhere. `devDependencies` is the only
  legal home.
- `packages/ai-mcp/test/boundary.test.ts` walks the *transitive import graph*
  from the dev bridge's entry points and fails if it ever reaches
  `@basaltkit/core`, `@basaltkit/http`, `@basaltkit/mcp` or `@basaltkit/cli`.

So the boundary can't rot silently: the moment the AI layer reaches into the
runtime, CI goes red. Every SaaS built with the ecosystem keeps the same,
reusable architecture — the framework owns it; the AI is a tool that speaks it.

## See also

- [AI in your editor (MCP bridge)](/guide/ai-mcp) — the same workflows as MCP tools.
- [MCP (runtime)](/guide/mcp) — your app's routes as tools, in production. A
  different product from this page.
- [`@basaltkit/mcp-core`](/guide/mcp-core) — the zero-dependency protocol layer both bridges sit on.
- [Tenancy](/guide/tenancy) · [Teams](/guide/teams) · [Security](/guide/security) —
  what the doctor's tenancy and security rules are pointing you at.
- [Getting started](/guide/getting-started) — `create-basalt --cli` wires the CLI entry for you.
