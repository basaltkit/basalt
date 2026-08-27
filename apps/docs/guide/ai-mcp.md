# AI in your editor (MCP bridge)

`@basaltkit/ai-mcp` is a **dev-only** [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes Basalt's AI developer workflows — analyze, doctor, plan,
review and scaffold — to MCP clients like **Claude Code** and **Claude Desktop**,
over **stdio** (default) or optional HTTP. Point it at your project and ask an
agent to build a feature; it plans against your real stack, previews the diff, and
only writes when you say so.

::: tip It's a bridge, never a runtime dependency.
`@basaltkit/ai-mcp` only *uses* the framework's official public APIs (via
[`@basaltkit/ai`](./ai)). It depends solely on `@basaltkit/ai` and the zero-dep
[`@basaltkit/mcp-core`](./mcp-core) — **never** on `@basaltkit/core`,
`@basaltkit/http`, or the runtime [`@basaltkit/mcp`](./mcp). It must never be a
runtime dependency of your app; install it as a `devDependency` (or run it with
`npx`). A machine test in the repo enforces this.
:::

[[toc]]

## The four layers

Basalt keeps intelligence, the dev bridge, the wire, and the runtime strictly
separate:

| Package | Role | Runtime? |
| --- | --- | --- |
| [`@basaltkit/ai`](./ai) | Intelligence — the `basalt ai` CLI, providers, the plan/make/review engine | dev-only |
| **`@basaltkit/ai-mcp`** | **This page.** A dev-only MCP server exposing those workflows to MCP clients | dev-only |
| [`@basaltkit/mcp-core`](./mcp-core) | Zero-dependency MCP wire: protocol + generic server + stdio/HTTP transports | shared |
| [`@basaltkit/mcp`](./mcp) | The app's *runtime* MCP surface — opt-in routes become tools | runtime |

`@basaltkit/ai-mcp` and `@basaltkit/mcp` both speak MCP, but they are different
products: the runtime `mcp` exposes *your app's routes* to agents in production;
`ai-mcp` exposes *dev workflows* (scaffolding, diagnostics) to your editor while
you build. Never confuse the two.

## Quickstart (Claude Code / Desktop)

No install needed — the bridge runs via `npx`. It reads your project from `--cwd`.

### Claude Code

From your project root:

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

Or commit a project-scoped `.mcp.json` at the repo root (this is what
`create-basalt --mcp` generates for you):

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=."]
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), then
restart Claude Desktop:

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=/absolute/path/to/my-basalt-app"]
    }
  }
}
```

### What you can now ask

Once connected, the agent has your project's stack and tools. Try:

- *"Analyze this Basalt project and tell me what's enabled."* → `basalt_analyze`
- *"Run the doctor and show me any tenancy or security issues."* → `basalt_doctor`
- *"Plan an Invoice resource with amount and status, tenant-scoped."* → `basalt_plan`
- *"Preview making it, then apply it if it looks safe."* → `basalt_make`

The read-only tools (`analyze`, `doctor`) and `make` **preview** need no API key.
Planning and review call an LLM — see [Provider setup](#provider-setup-for-plan-review).

## Scaffold a new app that's MCP-ready

`create-basalt` wires the bridge for you when you opt into MCP:

```bash
npm create basalt my-saas -- --mcp
```

This adds `@basaltkit/ai-mcp` to **devDependencies** (never dependencies), writes
a project-root `.mcp.json`, and documents it in the app's README. See
[`create-basalt`](./getting-started).

## The tools

Five tools, mapping to the `basalt ai` CLI surface. `structuredContent` mirrors
the text output on every call, and each tool advertises an `outputSchema` derived
from [`@basaltkit/ai`](./ai)'s exported Zod schemas.

| Tool | Purpose | Needs a provider? | Writes files? |
| --- | --- | --- | --- |
| `basalt_analyze` | Detected stack, data model, diagnostics | no | no |
| `basalt_doctor` | Diagnostics **+ in-memory fix previews** | no | no |
| `basalt_plan` | Natural language → `ArchitecturePlan` | **yes** | no |
| `basalt_review` | LLM critique of a build → verdict | **yes** | no |
| `basalt_make` | Scaffold a resource vertical | preview: no\* / apply: — | **apply only** |

<small>\* `basalt_make` needs a provider only when you pass a `request` instead of
a ready `plan` (it plans internally first).</small>

### `basalt_analyze`

Static, offline analysis. Input `{ workspaceRoot? }`; output an `AnalysisReport`
(capabilities, installed packages, database, models, tenant-scoped vs unscoped
models, diagnostics).

### `basalt_doctor`

Diagnoses configuration, security and tenancy issues, and **previews** the
available auto-fixes — the files each would change, computed in memory. It never
writes. Output `{ diagnostics, hasErrors, fixes: [{ id, status, message, files }] }`.

### `basalt_plan`

Turns a request into a grounded `ArchitecturePlan` (entities, steps, permissions,
audit events, warnings, `schemaVersion`). Input:

```jsonc
{
  "request": "an Invoice resource: amount, status (pago|pendente), tenant-scoped",
  "workspaceRoot": ".",      // optional
  "temperature": 0,          // optional
  "maxTokens": 4096          // optional
}
```

Read-only — it produces a plan, it changes nothing. Streams progress and can be
cancelled (see [Long-running operations](#long-running-operations)).

### `basalt_review`

An LLM pass over a build result against its plan (tenancy, security, RBAC,
validation, tests, fit). Input `{ plan, makeResult }`; output an `AgentReview`
whose `approved` flag is derived from the issues — an error-severity issue blocks.

### `basalt_make`

Implements a plan: scaffolds the resource vertical (schema, repository, service,
routes, tests) and wires it into `src/app.ts`. **Safe by construction** — see the
next section. Input:

```jsonc
{
  "plan": { /* an ArchitecturePlan from basalt_plan */ },
  // or, instead of plan:
  "request": "an Invoice resource …",  // plans then makes (needs a provider)
  "workspaceRoot": ".",                 // optional, confined to the launch dir
  "mode": "preview",                    // "preview" (default) | "apply"
  "force": false,                       // overwrite existing files (apply only)
  "migrate": false                      // run `prisma db push` (apply only)
}
```

Plan↔make correlation is **stateless**: the client carries the full
`ArchitecturePlan` (with its `schemaVersion`) from `basalt_plan` into `basalt_make`
— there is no server-side plan store.

## Safe `make`

Writing files from an autonomous agent is the risky part, so the safety model is
the whole point.

- **Preview is the default and writes nothing.** With no `mode` (or
  `mode:"preview"`), the tool returns `preview.perFile[]` — every file it *would*
  write, each with an `action` (`create` | `overwrite`) and a **unified diff** —
  plus `preview.clashes` (paths that already exist). Nothing touches disk.
- **Apply is explicit.** `mode:"apply"` is required to write.
- **Overwrites need `force`.** An `apply` refuses to clobber existing files unless
  `force:true`.
- **`migrate` is double-gated.** `prisma db push` runs only when `migrate:true`,
  and never as a default.
- **Writes are confined to the workspace.** A `workspaceRoot` (or any target path)
  that escapes the launch directory — via `..` traversal, an absolute path, or a
  symlink — is rejected *before any write*. An agent cannot write outside your
  project.
- **Confirmation.** When the client supports MCP elicitation, an `apply` is
  confirmed interactively; the explicit preview → apply two-call flow is the floor.

The recommended loop:

```text
basalt_analyze            → understand the stack
basalt_plan(request)      → get an ArchitecturePlan
basalt_make(plan)         → PREVIEW: read the diffs + clashes
basalt_review(plan, prev) → catch tenancy/security/RBAC issues
basalt_make(plan, apply)  → write, only when the preview + review look right
```

## Resources & prompts

### Resources — pull project state as context

Read-only reflections of your workspace the agent can read directly:

| URI | Contents |
| --- | --- |
| `basalt://project/context` | The detected `ProjectContext` — stack, Prisma models, app/server/env files |
| `basalt://project/analysis` | The `AnalysisReport` — capabilities, data-model summary, diagnostics |
| `basalt://project/diagnostics` | The doctor findings |
| `basalt://knowledge/architecture` | The BasaltKit conventions the planner is grounded in |

### Prompts — workflow templates

Four prompt templates encode the safe loop and reference the tools by name, so
even a naive agent follows preview-before-write:

| Prompt | Arguments | Guides |
| --- | --- | --- |
| `plan-feature` | `request` | analyze → plan → make preview → review → make apply |
| `scaffold-resource` | `name`, `fields?` | a focused single-entity build |
| `harden-tenancy` | — | doctor → review tenancy fixes → apply |
| `add-rbac` | `resource` | wire permission guards for a resource |

In Claude Code, prompts surface as slash commands (e.g. `/plan-feature`).

## Provider setup (for plan / review)

`basalt_plan`, `basalt_review`, and `basalt_make` *with a `request`* call a model.
Configuration is read from the environment the MCP client launches the server
with — the same variables the [`@basaltkit/ai` CLI uses](./ai#choose-a-provider):

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `anthropic` (default), `openai` (any OpenAI-compatible gateway), or `ollama` |
| `AI_API_KEY` | The vendor key (not needed for Ollama) |
| `AI_BASE_URL` | Gateway base URL (e.g. an OpenAI-compatible `/v1`) |
| `AI_MODEL` | Model id override |

Pass them through the client's `env` block:

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=."],
      "env": { "AI_PROVIDER": "anthropic", "AI_API_KEY": "sk-ant-…" }
    }
  }
}
```

::: warning Keys stay in memory
The bridge reads provider keys only to construct the provider in-process. It never
logs, persists, or echoes them. The read-only tools (`analyze`, `doctor`) and
`make` preview need no key at all.
:::

## Long-running operations

`plan`, `review` and `make` report progress and can be cancelled through the MCP
protocol:

- **Progress** — pass a `_meta.progressToken` with your `tools/call`; the bridge
  emits `notifications/progress` as the model streams and as `make` builds each
  resource. (Live progress requires stdio — see Transports.)
- **Cancellation** — send `notifications/cancelled` with the request id; the
  in-flight generation is aborted promptly.

## Transports

| Transport | When | How |
| --- | --- | --- |
| **stdio** (default) | Local dev; Claude Code/Desktop spawn the server | just run the bin |
| **HTTP** (opt-in) | Remote/CI, shared team server | `basalt-ai-mcp --http[=port]` |

```bash
# stdio (default) — the client launches this
npx @basaltkit/ai-mcp --cwd=.

# HTTP on an ephemeral port (prints the URL); loopback-only
npx @basaltkit/ai-mcp --http --cwd=.

# HTTP on a fixed port
npx @basaltkit/ai-mcp --http=8848 --cwd=.
```

The HTTP transport is request/response JSON-RPC over `POST /mcp` (minimal, no SSE);
use stdio when you need live progress streaming.

## Programmatic use

For tests or embedding, build the server without a transport and drive it
directly:

```ts
import { buildAiMcpServer } from '@basaltkit/ai-mcp'

const server = buildAiMcpServer({ cwd: '/path/to/project' })
const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

`createAiMcpServer(opts)` starts stdio; `createAiMcpHttpServer(opts)` starts HTTP.
Both accept `cwd`, an injectable `createReader` (for tests over an in-memory
project), and `createProvider` (to inject a mock model — no network).

## Troubleshooting / FAQ

**"basalt_plan needs an AI provider…"** — set `AI_API_KEY` (and optionally
`AI_PROVIDER`/`AI_MODEL`) in the client's `env` block, or run Ollama locally
(`AI_PROVIDER=ollama`). `analyze`/`doctor` and `make` preview don't need one.

**The agent can't see my project.** — Check `--cwd` points at the project root
(where `package.json` / `prisma/schema.prisma` live). With `.mcp.json`, `--cwd=.`
resolves to the directory Claude Code opened.

**`basalt_make apply` refused with "without force".** — The target files already
exist. Review the preview diffs, then re-run `mode:"apply"` with `force:true`.

**"workspaceRoot escapes the launch directory".** — By design: writes are confined
to the launch subtree. Use a path inside the project.

**Routes 500 after apply.** — A Prisma model was added but the client wasn't
regenerated. Re-run `apply` with `migrate:true`, or run `npx prisma db push`
yourself, then restart the dev server.

**Is this safe to leave connected?** — Yes. Nothing writes without an explicit
`mode:"apply"`, overwrites need `force`, DB changes need `migrate`, and all writes
are confined to the project.

## See also

- [AI-assisted development](./ai) — the `basalt ai` CLI the bridge is built on.
- [`@basaltkit/mcp-core`](./mcp-core) — build your own MCP server on the same wire.
- [MCP (runtime)](./mcp) — expose your app's routes as tools in production.
- Architecture: `docs/rfcs/0001-basaltkit-ai-mcp.md`. Source:
  `packages/ai-mcp/src/**` (tools, resources, prompts, `safety.ts`, `server.ts`, `bin.ts`).
