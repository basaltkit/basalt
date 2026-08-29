<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/ai-mcp

A **dev-only** Model Context Protocol server that exposes Basalt's AI developer workflows —
analyze, doctor, plan, make, review — to MCP clients (Claude Desktop, Claude Code, any
agent) over **stdio**, or over an opt-in local HTTP transport.

## The layer boundary (read this first)

This package is a **bridge, not a runtime**. It calls only the framework's official public
APIs (`@basaltkit/ai`) and depends solely on `@basaltkit/ai` and the zero-dependency
`@basaltkit/mcp-core` — **never** on `@basaltkit/core`, `@basaltkit/http`, or the runtime
`@basaltkit/mcp`.

> **It must never be a runtime dependency of your application.** Install it as a
> `devDependency`, or don't install it at all and let the MCP client run it with
> `npx -y @basaltkit/ai-mcp`. Nothing in your app should ever `import` from it. The
> framework owns the architecture; the AI layer only *uses* it.

| Layer | Package | Runs where |
|---|---|---|
| Protocol substrate | `@basaltkit/mcp-core` | anywhere; zero dependencies |
| App's **runtime** MCP surface | `@basaltkit/mcp` | inside your booted app — that's the one you register |
| **Dev-only** AI bridge | **`@basaltkit/ai-mcp`** (this one) | on a developer's machine or in CI, as a separate process |

If you want your *application* to expose tools to an agent, you want `@basaltkit/mcp`.

## Capabilities

### Tools

| Tool | What it does | Needs a provider? | Writes? |
| --- | --- | --- | --- |
| `basalt_analyze` | Detected stack (HTTP/ORM/tenancy/auth/RBAC/audit/…), data model and diagnostics. | no | no |
| `basalt_doctor` | Diagnostics **plus a preview** of the available auto-fixes (which files each would change — computed in memory). | no | no |
| `basalt_plan` | Turns a natural-language request into a grounded `ArchitecturePlan` (entities, steps, permissions, audit events). | yes | no |
| `basalt_make` | Implements a plan: scaffolds the resource vertical (schema, repository, service, routes, tests) and wires it in. **Preview by default.** | only with `request` instead of `plan` | only with `mode: 'apply'` |
| `basalt_review` | LLM critique of a build result against its plan (tenancy, security, RBAC, validation, tests, fit) with an approve/reject verdict. | yes | no |

Every tool returns `structuredContent` mirroring its text output, with an `outputSchema`
derived from `@basaltkit/ai`'s exported schemas. `basalt_analyze`, `basalt_doctor`,
`basalt_plan` and `basalt_make` accept an optional `workspaceRoot` and otherwise default to
the server's workspace root. The provider-backed tools stream progress and honour
cancellation through the MCP tool context.

Tool arguments:

| Tool | Argument | Type | Default | Purpose |
|---|---|---|---|---|
| all except `basalt_review` | `workspaceRoot` | `string` | server workspace root | Which project to act on. For `basalt_make` it must stay **inside the launch directory**. |
| `basalt_plan` | `request` | `string` (required) | — | What to build, in natural language. |
| `basalt_plan` | `temperature` | `number` | provider default | `0` for deterministic planning. |
| `basalt_plan` | `maxTokens` | `integer` | provider default | Hard cap on output tokens. |
| `basalt_make` | `plan` | `ArchitecturePlan` | — | The plan from `basalt_plan`. Either this **or** `request` is required. |
| `basalt_make` | `request` | `string` | — | Alternative to `plan`: plan and make in one call (needs a provider). |
| `basalt_make` | `mode` | `'preview' \| 'apply'` | `'preview'` | `preview` writes nothing and returns per-file diffs + clash flags. |
| `basalt_make` | `force` | `boolean` | `false` | Overwrite files that already exist. `apply` only. |
| `basalt_make` | `migrate` | `boolean` | `false` | Run `prisma db push` after writing. `apply` only. |
| `basalt_review` | `plan` | `ArchitecturePlan` (required) | — | The plan from `basalt_plan`. |
| `basalt_review` | `makeResult` | `MakeResult` (required) | — | The result from `basalt_make`. |

### How `basalt_make` stays safe

The only tool that can touch your disk is safe by construction, in this order:

1. **Preview is the default.** `mode` must be explicitly `'apply'` to write anything.
2. **The write root is confined.** An explicit `workspaceRoot` is honoured only while it
   stays inside the launch directory *after symlink resolution*; otherwise the call is
   refused. An autonomous agent must not be able to redirect writes out of the project.
3. **Every target path is re-checked** before writing: no absolute paths, no `..`, no
   symlink that resolves outside the workspace.
4. **A dry run always happens first**, even for `apply` — its per-file diffs and clash list
   are what the later gates are checked against.
5. **Overwrites need `force: true`.** Clashes are refused with the file list.
6. **`prisma db push` needs `migrate: true`.**
7. **Elicitation.** When the client supports it, an `apply` is confirmed with a one-line
   summary of what will be written before anything happens.

Refusals come back as a normal failed tool result (`isError: true`) with an actionable
message — never as a protocol error, and never as a silent no-op.

### Resources

| URI | Contents |
| --- | --- |
| `basalt://project/context` | The detected `ProjectContext` (stack, Prisma models, app/server/env files). |
| `basalt://project/analysis` | The `AnalysisReport` (capabilities, data-model summary, diagnostics). |
| `basalt://project/diagnostics` | The doctor findings (security, tenancy, database, observability, config, …). |
| `basalt://knowledge/architecture` | The BasaltKit conventions and architectural rules the planner is grounded in. |

### Prompts

Workflow templates that encode the safe loop (analyze → plan → **preview** → review →
apply) and name the real tools, so even a naive agent follows the preview-before-write
path: `plan-feature` (arg `request`), `scaffold-resource` (args `name`, `fields`),
`harden-tenancy`, `add-rbac` (arg `resource`).

## Install & configure

The server is a stdio process the MCP client launches. Point it at your Basalt project with
`--cwd` (defaults to the process working directory).

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=/absolute/path/to/my-basalt-app"],
      "env": { "AI_API_KEY": "sk-…" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

Or add it to `.mcp.json` at your project root:

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

### Generic MCP client

Any client that speaks MCP over stdio: run `basalt-ai-mcp` (from a dev install) or
`npx -y @basaltkit/ai-mcp`.

### CLI flags (`basalt-ai-mcp`)

| Flag | Default | Purpose |
|---|---|---|
| `--cwd=<path>` | `process.cwd()` | The workspace root the tools and resources default to. |
| `--http[=<port>]` | off (stdio) | Serve over the opt-in local HTTP transport instead of stdio. Bare `--http` picks an ephemeral port; the chosen URL is printed on stdout. |
| `--host=<host>` | `127.0.0.1` | Bind address for `--http`. Loopback by default — this is a dev surface. |

stdio is the default and the recommended local path; it is also the only transport that
delivers live progress notifications.

### Provider configuration

`basalt_analyze` and `basalt_doctor` are fully offline and need no keys. `basalt_plan`,
`basalt_review` and `basalt_make`-with-`request` need an AI provider, configured through
the environment the launching client passes in its `env` block:

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `anthropic` (default), `openai`, `ollama`, … |
| `AI_API_KEY` | The provider key. |
| `AI_MODEL` | Model override. |
| `AI_BASE_URL` | Point at an OpenAI-compatible gateway, or a local Ollama. |

Keys are read into memory to construct the provider and nothing else: this package never
logs, persists or echoes them. A missing/invalid key produces a failed tool result naming
the variables to set — never the value of one.

## Programmatic use (tests / embedding)

```ts
import { buildAiMcpServer } from '@basaltkit/ai-mcp'

const server = buildAiMcpServer({ cwd: '/path/to/project' })
const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

| Export | Signature | Purpose |
|---|---|---|
| `buildAiMcpServer(options?)` | `(AiMcpOptions) => McpServer` | Builds the `@basaltkit/mcp-core` server (tools + resources + prompts) without any transport. |
| `createAiMcpServer(options?)` | `(StartOptions) => StdioHandle` | Builds it and serves over stdio. This is what the bin calls. |
| `createAiMcpHttpServer(options?)` | `(HttpStartOptions) => Promise<HttpHandle>` | Builds it and serves over the opt-in HTTP transport. |
| `createSession(options?)` | `(SessionOptions) => Session` | The resolved session (workspace root, env, reader, provider factory). |
| `resolveWorkspaceRoot(session, arg)` | `(Session, unknown) => string` | Per-call root resolution: an explicit non-empty string argument, else the session default. |
| `AI_MCP_VERSION` | `string` | Version reported in `serverInfo`. |

`AiMcpOptions` (= `SessionOptions`):

| Option | Type | Default | Purpose |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | Workspace root the tools and resources default to, and the confinement root for `basalt_make`. |
| `env` | `Record<string, string \| undefined>` | `process.env` | Where provider config is read from. Pass a fixture in tests. |
| `createReader` | `(root: string) => ProjectReader` | `nodeReader` (filesystem) | Inject an in-memory reader to test without touching disk. |
| `createProvider` | `() => AIProvider` | built from `env` | Inject a mock provider — no network, no keys. |

`StartOptions` adds `input` / `output` (stdio stream injection, defaulting to
`process.stdin` / `process.stdout`). `HttpStartOptions` adds every `ServeHttpOptions`
field from `@basaltkit/mcp-core` — `port`, `host`, `path`, `allowedHosts`,
`allowedOrigins`, `allowRequest` — including its loopback-only, anti-DNS-rebinding and
anti-CSRF defaults.

## Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| `WorkspaceEscapeError` | — (`error.name`) | — | An internal guard: `workspaceRoot` or a target path would escape the launch directory (`..`, an absolute path, or a symlink out). Caught by `basalt_make` and returned as a `Refused: …` tool error. |
| *(failed tool result)* | — (`isError: true`) | — | Every user-facing failure: missing/invalid arguments, no AI provider, a clash without `force`, an unconfirmed elicitation, a cancelled call, or any workflow error. The message is in `content`. |
| *(JSON-RPC)* | `INVALID_PARAMS` (`-32602`) | 200 | Unknown tool/resource/prompt name, or a missing required protocol parameter — raised by `@basaltkit/mcp-core`, not here. |
| *(JSON-RPC)* | `INTERNAL_ERROR` (`-32603`) | 200 | An exception escaped a handler. Tools convert their own failures to results, so this is rare. |

Symptoms:

- **`basalt_plan needs an AI provider …`** — no `AI_API_KEY` in the client's `env` block.
  `basalt_analyze` / `basalt_doctor` still work; they're offline.
- **`Refusing to overwrite N existing file(s) without force:true`** — review the preview,
  then re-run `mode:"apply"` with `force:true` if the overwrite is intended.
- **`Refused: workspaceRoot '…' escapes the launch directory`** — relaunch the server with
  `--cwd` pointing at the project you actually want to write to.
- **`Apply cancelled — not confirmed.`** — the client's elicitation prompt was declined.
- **Progress never appears** — you're on `--http`; that transport has no server→client
  channel. Use stdio.

## How it connects to other modules

- **`@basaltkit/ai`** — the actual workflows: `analysis` (detect/analyze/doctor/planFix),
  `workflows` (createPlan/runMake/reviewImplementation/providers) and `schema`. This
  package only wires them onto MCP.
- **`@basaltkit/mcp-core`** — the protocol substrate: `McpServer`, `serveStdio`,
  `serveHttp`. Zero dependencies, which is what keeps this bridge out of the runtime.
- **`@basaltkit/mcp`** — the *other* MCP package: an application's runtime surface. Unrelated
  at build time; this one never imports it.

Guides: [AI MCP bridge](/guide/ai-mcp) · [AI](/guide/ai) · [MCP core](/guide/mcp-core) · [MCP](/guide/mcp)
