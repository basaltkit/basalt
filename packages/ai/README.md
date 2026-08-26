<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/ai

AI-native developer experience for Basalt. A provider-agnostic engine plus a
`basalt ai` CLI that **understands the project's stack**, analyzes it, and
diagnoses issues — following the framework's own conventions instead of inventing
new ones.

> **Status: 1.0 (stable).** The provider abstraction and the full `basalt ai`
> command surface — `ai:analyze`, `ai:doctor`, `ai:plan`, `ai:make`, `ai:review` —
> are settled and covered by semver: breaking changes land only in a new major.
> The AI layer stays **dev-only** — it is never a runtime dependency of your app.

## Install

```bash
pnpm add @basaltkit/ai
```

## CLI

Register the commands alongside the generator's, through `@basaltkit/cli`:

```ts
import { commandsPlugin } from '@basaltkit/cli'
import { generatorCommands } from '@basaltkit/generator'
import { aiCommands } from '@basaltkit/ai'

commandsPlugin([...generatorCommands(), ...aiCommands()])
```

Then:

```bash
basalt ai            # overview: detected stack + available commands
basalt ai:analyze    # static analysis report (read-only)
basalt ai:doctor     # diagnostics with suggested fixes (read-only)
```

All three are **deterministic and offline** — no API key required. `ai:doctor`
exits non-zero when it finds an error-severity issue, so you can gate CI on it.

### `basalt ai:analyze`

```
Analyzing project...

✓ Fastify detected
✓ Prisma detected
✓ PostgreSQL detected
✓ Tenancy enabled
✓ Authentication enabled
✓ RBAC enabled

Data model (3 models):
  • Tenant
  • Post  (tenant-scoped)
  • Invoice

Diagnostics: 1 error(s), 2 warning(s), 1 info.
Run `basalt ai:doctor` for details and fixes.
```

### `basalt ai:doctor`

Runs a rules engine over the project. Built-in rules include:

| id | severity | what it catches |
| --- | --- | --- |
| `insecure-app-secret` | error | `APP_SECRET` has a committed default (e.g. `change-me-…`) |
| `prisma-lazy-boot` | warning | server never `$connect()`s, so a wrong DB fails silently on first request |
| `fastify-logger-off` | warning | Fastify's logger is off, so 500s never print in the terminal |
| `tenant-scoping-missing` | warning | tenancy is on but some models lack `tenantId` |
| `memory-sources-in-use` | info | non-durable `Memory*Source` still wired |
| `redis-localhost-default` | info | `REDIS_URL` defaults to localhost with a queue/subscriptions backend |

## Provider abstraction

Vendor-agnostic by design (`AI_PROVIDER`): the agent depends on the `AIProvider`
interface, never a specific SDK.

```ts
import { createProvider } from '@basaltkit/ai'

const ai = createProvider(process.env) // AI_PROVIDER, AI_MODEL, AI_API_KEY, AI_BASE_URL
const answer = await ai.generate({ messages: [{ role: 'user', content: 'Hello' }] })
```

Wired now: **Anthropic** (default), **Ollama** (local, no key), and **any
OpenAI-compatible Chat Completions gateway** (`AI_PROVIDER=openai`) — OpenAI,
LiteLLM, OpenRouter, go4ai, etc. Google is stubbed with a clear error.

### OpenAI-compatible gateway

Point `AI_BASE_URL` at the gateway's `/v1`; the provider appends
`/chat/completions` and sends `Authorization: Bearer <AI_API_KEY>`:

```bash
export AI_PROVIDER=openai
export AI_BASE_URL=https://ai.go4ai.io/v1
export AI_API_KEY=sk_inf_xxx
export AI_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0

basalt ai:plan "Add a patients module"
```

## Programmatic API

Everything the CLI uses is exported, so you can build your own tooling:

```ts
import { detectProject, analyze, runDoctor } from '@basaltkit/ai'

const ctx = detectProject(process.cwd())
const report = analyze(ctx)          // stack, data model, diagnostics
const findings = runDoctor(ctx)      // Diagnostic[], most severe first
```

`detectProject` accepts an injectable reader (`memoryReader({...})`) so the whole
detection layer is testable without touching disk.

## License

MIT
