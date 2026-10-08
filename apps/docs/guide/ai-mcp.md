# AI in your editor (MCP bridge)

`@basaltkit/ai-mcp` is a **dev-only** [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes Basalt's AI developer workflows — analyze, doctor, plan,
review and scaffold — to MCP clients like **Claude Code** and **Claude Desktop**,
over **stdio** (default) or optional HTTP. Point it at your project and ask an
agent to build a feature; it plans against your real stack, previews the diff, and
only writes when you say so.

::: tip It's a bridge, never a runtime dependency.
`@basaltkit/ai-mcp` only *uses* the framework's official public APIs (via
[`@basaltkit/ai`](/guide/ai)). It depends solely on `@basaltkit/ai` and the zero-dep
[`@basaltkit/mcp-core`](/guide/mcp-core) — **never** on `@basaltkit/core`,
`@basaltkit/http`, `@basaltkit/cli`, or the runtime [`@basaltkit/mcp`](/guide/mcp).
Install it as a `devDependency` (or run it with `npx`). Two tests enforce this
mechanically: `packages/ai-mcp/test/boundary.test.ts` walks the transitive import
graph and fails if it ever reaches the runtime, and
`packages/ai-mcp/test/dev-only-guard.test.ts` fails if any workspace package lists
the AI layer outside `devDependencies`. At runtime, the server **refuses to start
when `NODE_ENV=production`** (`AiMcpProductionError`; the bin exits `1`), so a
deployed process that pulled it in fails loudly. Only an explicit `production`
refuses — MCP clients launch the bin without `NODE_ENV`, the normal dev path.
Override deliberately with `--allow-production` (`allowProduction: true`,
`BASALT_AI_MCP_ALLOW_PRODUCTION=1`).
:::

[[toc]]

## The four layers

Basalt keeps intelligence, the dev bridge, the wire, and the runtime strictly
separate:

| Package | Role | Runtime? |
| --- | --- | --- |
| [`@basaltkit/ai`](/guide/ai) | Intelligence — the `basalt ai` CLI, providers, the plan/make/review engine | dev-only |
| **`@basaltkit/ai-mcp`** | **This page.** A dev-only MCP server exposing those workflows to MCP clients | dev-only |
| [`@basaltkit/mcp-core`](/guide/mcp-core) | Zero-dependency MCP wire: protocol + generic server + stdio/HTTP transports | shared |
| [`@basaltkit/mcp`](/guide/mcp) | The app's *runtime* MCP surface — opt-in routes become tools | runtime |

`@basaltkit/ai-mcp` and `@basaltkit/mcp` both speak MCP, but they are different
products: the runtime `mcp` exposes *your app's routes* to agents in production;
`ai-mcp` exposes *dev workflows* (scaffolding, diagnostics) to your editor while
you build. Never confuse the two.

The bridge itself is thin. It builds an [`McpServer`](/guide/mcp-core) from
`mcp-core` with five tools, four resources and four prompts, each of which is a
thin wrapper over an exported `@basaltkit/ai` function. All the intelligence lives
one layer down; all the *safety* (workspace confinement, preview-before-write)
lives here.

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
Planning and review call an LLM — see Provider setup below.

## Scaffold a new app that's MCP-ready

`create-basalt` wires the bridge for you when you opt into MCP:

```bash
npm create basalt my-saas -- --mcp
pnpm basalt add mcp          # …or later, in an app created without --mcp
```

This adds `@basaltkit/ai-mcp` to **devDependencies** (never dependencies), writes
a project-root `.mcp.json`, and documents it in the app's README. See
[`create-basalt`](/guide/getting-started) and
[Adding features later](/guide/installation#adding-features-later).

## The tools

Five tools, mapping to the `basalt ai` CLI surface. `structuredContent` mirrors
the text output on every call, and each tool advertises an `outputSchema` derived
from [`@basaltkit/ai`](/guide/ai)'s exported Zod schemas.

| Tool | Purpose | Needs a provider? | Writes files? |
| --- | --- | --- | --- |
| `basalt_analyze` | Detected stack, data model, diagnostics | no | no |
| `basalt_doctor` | Diagnostics **+ in-memory fix previews** | no | no |
| `basalt_plan` | Natural language → `ArchitecturePlan` | **yes** | no |
| `basalt_review` | LLM critique of a build → verdict | **yes** | no |
| `basalt_make` | Scaffold a resource vertical | preview: no\* / apply: — | **apply only** |

<small>\* `basalt_make` needs a provider only when you pass a `request` instead of
a ready `plan` (it plans internally first).</small>

A tool failure is **never** a protocol error: bad arguments, a missing provider, a
refused write and a cancellation all come back as a normal result with
`isError: true` and the reason in `content` — so an agent can read it and adapt.
Only malformed JSON-RPC produces a real error code — including `arguments` that
is not a JSON object (`-32602`). An unexpected exception becomes `-32603` with the
generic text `Internal error`; the `basalt-ai-mcp` bin writes the real cause to
stderr (programmatic users get it through `onError`).

### `basalt_analyze`

Static, offline analysis. Input `{ workspaceRoot? }`; output an `AnalysisReport`
(capabilities, installed packages, database, models, tenant-scoped vs unscoped
models, diagnostics). `workspaceRoot` — here and in `basalt_doctor` / `basalt_plan`
— is confined to the server's `--cwd`: an absolute path elsewhere, `..`, or a
symlink that resolves outside is refused (`Refused: … is outside the project root`).

### `basalt_doctor`

Diagnoses configuration, security and tenancy issues, and **previews** the
available auto-fixes — the files each would change, computed in memory. It never
writes. Output `{ diagnostics, hasErrors, fixes: [{ id, status, message, files }] }`,
where `status` is `ready` · `noop` · `unfixable`.

Note that `fixes` only lists rules that are *both* firing *and* auto-fixable —
which today is just `fastify-logger-off` and `insecure-app-secret`. Everything
else in `diagnostics` is a manual fix; see the
[full rule table](/guide/ai).

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
cancelled (see Long-running operations below).

### `basalt_review`

An LLM pass over a build result against its plan (tenancy, security, RBAC,
validation, tests, fit). Input `{ plan, makeResult }` — both required objects;
output an `AgentReview` whose `approved` flag is derived from the issues — an
error-severity issue blocks.

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

The input schema declares `oneOf: [{ required: ['plan'] }, { required: ['request'] }]`
— exactly one of the two is the entry point.

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
- **The preview always runs first.** Even an `apply` computes the dry run before
  writing, so the confinement check below runs against the real target list.
- **Apply is explicit.** `mode:"apply"` is required to write.
- **Overwrites need `force`.** An `apply` refuses to clobber existing files unless
  `force:true`.
- **`migrate` is double-gated.** `prisma db push` runs only when `migrate:true`,
  and never as a default.
- **Writes are confined to the workspace.** A `workspaceRoot` (or any target path)
  that escapes the launch directory — via `..` traversal, an absolute path, or a
  symlink — is rejected *before any write*. Confinement resolves the nearest
  **existing** ancestor's realpath, so a symlink escape is caught even for a path
  that doesn't exist yet. An agent cannot write outside your project.
- **Confirmation — fail closed.** An `apply` is confirmed through MCP
  elicitation with a one-line summary of what will be written. Over stdio this
  works when the client announces the `elicitation` capability in `initialize`.
  When the client **cannot** be asked (no elicitation support, or the HTTP
  transport), the `apply` is **refused** — review the preview and apply it
  yourself — unless the server was started with `--allow-unconfirmed-apply`
  (programmatic: `allowUnconfirmedApply: true`).

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

Read-only reflections of your workspace the agent can read directly. They are
computed fresh on every `resources/read`, and always against the **server's**
workspace root (`--cwd`) — resources take no arguments:

| URI | MIME | Contents |
| --- | --- | --- |
| `basalt://project/context` | `application/json` | The detected `ProjectContext` — stack, Prisma models, app/server/env files |
| `basalt://project/analysis` | `application/json` | The `AnalysisReport` — capabilities, data-model summary, diagnostics |
| `basalt://project/diagnostics` | `application/json` | The doctor findings |
| `basalt://knowledge/architecture` | `text/markdown` | The Basalt conventions the planner is grounded in (`BASALT_KNOWLEDGE`) |

### Prompts — workflow templates

Four prompt templates encode the safe loop and reference the tools by name, so
even a naive agent follows preview-before-write:

| Prompt | Arguments | Guides |
| --- | --- | --- |
| `plan-feature` | `request` (required) | analyze → plan → make preview → review → make apply |
| `scaffold-resource` | `name` (required), `fields` (optional) | a focused single-entity build |
| `harden-tenancy` | — | doctor → review tenancy fixes → apply |
| `add-rbac` | `resource` (required) | wire permission guards for a resource |

In Claude Code, prompts surface as slash commands (e.g. `/plan-feature`).

## Provider setup (for plan / review)

`basalt_plan`, `basalt_review`, and `basalt_make` *with a `request`* call a model.
Configuration is read from the environment the MCP client launches the server
with — the same variables the [`@basaltkit/ai` CLI uses](/guide/ai):

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `anthropic` (default), `openai` (any OpenAI-compatible gateway), or `ollama` |
| `AI_API_KEY` | The vendor key (not needed for Ollama) |
| `AI_BASE_URL` | Gateway base URL (e.g. an OpenAI-compatible `/v1`) |
| `AI_MODEL` | Model id override |
| `AI_STREAM` | `'false'` disables SSE streaming on the OpenAI-compatible provider |

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
The bridge reads provider keys only to construct the provider in-process, and only
when a provider-backed tool is actually called (the session builds it lazily). It
never logs, persists, or echoes them — and the `providerHelp` error message that
guides you when configuration is missing deliberately names only the knobs, never
a value. The read-only tools (`analyze`, `doctor`) and `make` preview need no key
at all.
:::

## Long-running operations

`plan`, `review` and `make` report progress and can be cancelled through the MCP
protocol:

- **Progress** — pass a `_meta.progressToken` with your `tools/call`; the bridge
  emits `notifications/progress` as the model streams and as `make` builds each
  resource. (Live progress requires stdio — see Transports.)
- **Cancellation** — send `notifications/cancelled` with the request id; the
  in-flight generation is aborted promptly and the tool returns
  `isError: true` with the text `Cancelled.`

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

::: warning HTTP is guarded, and binds loopback by default
The HTTP transport binds `127.0.0.1` and rejects requests whose `Host` header
isn't a loopback name (anti-DNS-rebinding) or whose `Origin`, *when present*, isn't
a loopback origin (anti-CSRF — a browser always sends `Origin` on a cross-site
POST, so its absence means a non-browser client). A rejected request gets
`403` and never reaches a tool.

That guard stops browsers; it is **not authentication** (any non-browser client
can send `Host: 127.0.0.1`). So binding elsewhere (`--host=0.0.0.0` for CI) is
**refused** unless you also give a token — `--token=<secret>` or
`BASALT_AI_MCP_TOKEN` — which every request must then send as
`Authorization: Bearer <secret>`. Add the hostnames clients use with
`--allowed-hosts=ci.internal,…`. Request bodies are capped at 1 MiB (`413`).
:::

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

## Options reference

### CLI flags (`basalt-ai-mcp`)

| Flag | Type | Default | Purpose |
| --- | --- | --- | --- |
| `--cwd=<path>` | string | `process.cwd()` | The project root every tool and resource reads. With `.mcp.json`, `--cwd=.` resolves to the directory the client opened |
| `--http` / `--http=<port>` | boolean / number | stdio (off) | Switch to the HTTP transport. Bare `--http` uses port `0` — an ephemeral port, printed on stdout as `basalt-ai-mcp listening on <url>` |
| `--host=<host>` | string | `127.0.0.1` | Bind address; only read when `--http` is present. Binding off loopback requires `--token` |
| `--token=<secret>` | string | `BASALT_AI_MCP_TOKEN` | HTTP only: require `Authorization: Bearer <secret>` on every request. Mandatory for a non-loopback `--host` |
| `--allowed-hosts=<a,b>` | comma list | loopback names only | HTTP only: extra `Host` hostnames to accept when bound off loopback |
| `--sessions` | boolean | off (stateless) | HTTP only: turn on `Mcp-Session-Id` sessions, so a `notifications/cancelled` POSTed separately cancels a running call (see `sessions` below) |
| `--allow-unconfirmed-apply` | boolean | off | Let `basalt_make` apply when the client cannot confirm (no elicitation). Off by default: such an apply is refused |
| `--allow-production` | boolean | off (`BASALT_AI_MCP_ALLOW_PRODUCTION`) | Start even when `NODE_ENV=production`. Off by default: the dev-only bridge refuses to start there |

### `buildAiMcpServer(options)` · `createAiMcpServer(options)`

`AiMcpOptions` is the session config; `createAiMcpServer` adds the stdio streams.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Workspace root tools and resources default to; also the confinement root for every tool's `workspaceRoot` (reads and writes) |
| `env` | `Record<string, string \| undefined>` | `process.env` | Where provider config (and `NODE_ENV`, for the dev-only guard) is read from — inject a fixed env instead of the process's |
| `createReader` | `(root: string) => ProjectReader` | `nodeReader` | How project files are read. Inject an in-memory reader to test without disk |
| `createProvider` | `() => AIProvider` | built from `env` | Inject a mock model — no network, no keys |
| `allowUnconfirmedApply` | `boolean` | `false` | Let `basalt_make` apply without an elicitation confirmation. Default: refuse (fail closed) |
| `allowProduction` | `boolean` | `false` | Build even when `NODE_ENV=production`. Default: throw `AiMcpProductionError` (`createAiMcpHttpServer` rejects with it) |
| `onError` | `(error: unknown, message: JsonRpcRequest) => void` | none (the bin logs to stderr) | Receives the original error when a tool/resource/prompt throws; the client only sees `Internal error` |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | stdio only: read JSON-RPC from a different stream (tests) |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | stdio only: write JSON-RPC to a different sink (tests) |

`createAiMcpServer` returns a `StdioHandle` whose `close()` detaches the stdin
listener.

### `createAiMcpHttpServer(options)`

`AiMcpOptions` plus `mcp-core`'s `ServeHttpOptions`. Returns a `Promise<HttpHandle>`
(`{ port, url, close() }`).

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `port` | `number` | `0` | `0` picks an ephemeral port (read it back from `handle.port` / `handle.url`) |
| `host` | `string` | `'127.0.0.1'` | Bind address. Loopback by default — this is a dev surface |
| `path` | `string` | `'/mcp'` | JSON-RPC endpoint path. No CLI flag; programmatic only |
| `allowedHosts` | `string[]` | loopback names only | Extra `Host` hostnames to accept when you deliberately bind off loopback. Compared case-insensitively, port ignored |
| `allowedOrigins` | `string[]` | loopback origins only | Extra `Origin` values to accept (full scheme + host + port) |
| `allowRequest` | `(origin, host, req) => boolean` | — | Full override of the guard; **replaces** the loopback/`allowedHosts`/`allowedOrigins` checks |
| `token` | `string` | — | Require `Authorization: Bearer <token>` (constant-time compare, via `bearerAuthorizer`). Needed for a non-loopback `host` |
| `authorize` | `(req) => boolean \| Promise<boolean>` | — | Custom authentication instead of `token`; `false` answers `401` |
| `maxBodyBytes` | `number` | `1048576` | Larger bodies get `413` |
| `sessions` | `boolean \| { ttlMs?, maxSessions? }` | `false` | Streamable-HTTP sessions: `initialize` answers with an `Mcp-Session-Id`, every later request must carry it (`400` without, `404` unknown/expired/foreign — re-initialize), `DELETE` ends it, and a separate `notifications/cancelled` cancels the call it names within the same session only. Off by default so header-less clients keep working |
| `principal` | `(req) => string \| undefined` | hash of `Authorization` | Who owns a session — a request resolving to another principal gets `404` |

### Tool arguments

| Tool | Argument | Type | Default | Purpose |
| --- | --- | --- | --- | --- |
| `basalt_analyze` · `basalt_doctor` | `workspaceRoot` | `string` | server `cwd` | Analyze a sub-project (absolute or relative). Must stay inside `cwd` — enforced, symlinks resolved |
| `basalt_plan` | `request` | `string` | — (required) | What to build, in natural language |
| `basalt_plan` | `workspaceRoot` | `string` | server `cwd` | Ground the plan in a sub-project. Must stay inside `cwd` — enforced |
| `basalt_plan` | `temperature` | `number` | `0` | Sampling temperature; `0` keeps plans reproducible |
| `basalt_plan` | `maxTokens` | `integer` | `4096` | Raise it for a large multi-entity plan that gets truncated |
| `basalt_review` | `plan` / `makeResult` | object | — (both required) | The `basalt_plan` output and the `basalt_make` output to critique |
| `basalt_make` | `plan` **or** `request` | object / string | — (exactly one) | A ready plan, or a request to plan first (needs a provider) |
| `basalt_make` | `workspaceRoot` | `string` | server `cwd` | Must stay inside the launch directory — enforced, not advisory |
| `basalt_make` | `mode` | `'preview' \| 'apply'` | `'preview'` | `apply` is the only value that writes |
| `basalt_make` | `force` | `boolean` | `false` | Allow overwriting the paths reported in `preview.clashes` |
| `basalt_make` | `migrate` | `boolean` | `false` | Run `prisma db push` after writing (apply only) |

## Failure modes & troubleshooting

Tool-level failures ride in the result (`isError: true`); only malformed JSON-RPC
produces a protocol error code.

| Message | Kind | Where | When |
| --- | --- | --- | --- |
| `basalt_plan needs an AI provider — …` (also `basalt_make` / `basalt_review`) | `isError` | `providerHelp` | `createProvider` threw — no `AI_API_KEY`, or an unknown `AI_PROVIDER` |
| `basalt_plan requires a non-empty "request".` | `isError` | `basalt_plan` | The `request` argument was missing or blank |
| `basalt_make requires either a "plan" (from basalt_plan) or a "request" to plan.` | `isError` | `basalt_make` | Neither entry point was supplied |
| `basalt_review requires a "plan" object (from basalt_plan).` / `… a "makeResult" object …` | `isError` | `basalt_review` | A required object argument was missing |
| `Refused: workspaceRoot '<x>' escapes the launch directory (<root>)` | `isError` | `WorkspaceEscapeError` | `basalt_make`: `workspaceRoot` resolved outside `--cwd` — by design |
| `Refused: workspaceRoot '<x>' is outside the project root (<root>)` | `isError` | `WorkspaceEscapeError` | `basalt_analyze` / `basalt_doctor` / `basalt_plan`: `workspaceRoot` (or a symlink in it) resolves outside `--cwd` |
| `Refused: absolute path not allowed: <p>` · `Refused: path escapes workspace: <p>` · `Refused: path resolves outside workspace via symlink: <p>` | `isError` | `assertConfined` | A target file would land outside the workspace |
| `Refusing to overwrite N existing file(s) without force:true — …` | `isError` | `basalt_make` | An `apply` hit `preview.clashes`. Review the diffs, then re-run with `force:true` |
| `Apply cancelled — not confirmed.` | `isError` | `basalt_make` | The client's elicitation prompt was declined |
| `Refusing to apply without confirmation — …` | `isError` | `basalt_make` | The client cannot elicit (or HTTP transport) and the server was not started with `--allow-unconfirmed-apply` |
| `Cancelled.` | `isError` | any provider-backed tool | A `notifications/cancelled` aborted the in-flight call |
| `Unknown tool: <name>` | JSON-RPC `-32602` | `mcp-core` | The client called a tool that isn't one of the five |
| ``tools/call `arguments` must be an object`` | JSON-RPC `-32602` | `mcp-core` | `arguments` was an array, string, number or `null`; no tool ran |
| `Internal error` | JSON-RPC `-32603` | `mcp-core` | A tool/resource/prompt threw unexpectedly; the bin prints `basalt-ai-mcp: internal error in <method> — …` to stderr |
| `Method not found: <method>` | JSON-RPC `-32601` | `mcp-core` | An MCP method outside the implemented set |
| `Forbidden: host/origin not allowed` | HTTP `403` | `serveHttp` | The HTTP guard rejected a foreign `Host`/`Origin` before dispatch |
| `Unauthorized` | HTTP `401` | `serveHttp` | `--token` is set and the request's bearer token is missing/wrong |
| `failed to start HTTP server — serveHttp: refusing to bind non-loopback host …` | startup | bin | `--host` off loopback without `--token` |
| `failed to start … refuses to start with NODE_ENV=production` | startup (exit `1`) | bin / `AiMcpProductionError` | `NODE_ENV=production` in the client's `env` block or shell, without `--allow-production` |
| `Bad Request: Mcp-Session-Id header required …` | HTTP `400` | `serveHttp` | `--sessions` is on and the request carries no session header — `initialize` first |
| `Session not found (expired or unknown) — initialize again` | HTTP `404` | `serveHttp` | `--sessions` is on and the session id is unknown, expired or opened by another token |

- **The agent can't see my project** — check `--cwd` points at the project root
  (where `package.json` / `prisma/schema.prisma` live). Resources always use the
  server's `--cwd`; only *tools* accept a per-call `workspaceRoot`.
- **`basalt_doctor` shows errors but almost no `fixes`** — expected. Only two rules
  have auto-fixers; the rest are deliberate manual decisions.
- **Routes 500 after `mode:"apply"`** — a Prisma model was added but the client
  wasn't regenerated. Re-run `apply` with `migrate:true`, or run
  `npx prisma db push` yourself, then restart the dev server.
- **Progress never arrives** — you're on the HTTP transport. It's request/response
  only; server→client notifications need stdio.
- **The server starts but the client shows nothing** — on stdio, stdout *is* the
  JSON-RPC channel. Anything else written there corrupts the stream; the bridge
  itself only prints to stdout in `--http` mode.
- **Is this safe to leave connected?** — Yes. Nothing writes without an explicit
  `mode:"apply"`, overwrites need `force`, DB changes need `migrate`, and all writes
  are confined to the project subtree.

## See also

- [AI-assisted development](/guide/ai) — the `basalt ai` CLI the bridge is built on,
  including the full doctor rule table and provider configuration.
- [`@basaltkit/mcp-core`](/guide/mcp-core) — the protocol layer; build your own MCP server on it.
- [MCP (runtime)](/guide/mcp) — expose your app's routes as tools in production.
- Architecture: `docs/rfcs/0001-basaltkit-ai-mcp.md`. Source:
  `packages/ai-mcp/src/**` (tools, resources, prompts, `safety.ts`, `server.ts`, `bin.ts`).
