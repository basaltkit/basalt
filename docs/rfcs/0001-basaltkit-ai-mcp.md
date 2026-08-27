# RFC 0001 — `@basaltkit/ai-mcp`: a dev-only MCP bridge for the BasaltKit AI workflows

- **Status:** Draft (design pending maintainer approval — do NOT scaffold the package yet)
- **Author:** basalt-devtooling-architect
- **Date:** 2026-08-27
- **Affects:** `@basaltkit/ai`, `@basaltkit/mcp`, a new `@basaltkit/mcp-core`, a new `@basaltkit/ai-mcp`
- **Non-negotiables honoured:** AI/codegen layer is **dev-only**; layer separation (`ai` = intelligence, `ai-mcp` = dev bridge, `mcp` = runtime surface); framework conventions win; ground everything in real source.

---

## 0. TL;DR

`@basaltkit/ai` already implements a clean, provider-agnostic `analyze → plan → make → review`
workflow (`packages/ai/src/**`) driven by the `basalt ai:*` CLI (`packages/ai/src/commands.ts`).
`@basaltkit/mcp` already speaks MCP over JSON-RPC with no SDK, including a pure-streams stdio loop
(`packages/mcp/src/{protocol,server,stdio}.ts`) — but its server is **route-bound** (tools come only
from `collectTools(routes, container)`), so it is the *runtime* surface, not reusable as-is for
function-shaped dev tools.

This RFC proposes `@basaltkit/ai-mcp`: a **dev-only** MCP server (bin `basalt-ai-mcp`, **stdio** primary)
that exposes `analyze / doctor / plan / make / review` as MCP **tools**, the project's architectural
context as MCP **resources**, and the workflow templates as MCP **prompts**. The load-bearing decision is
the **boundary**: extract a zero-dependency `@basaltkit/mcp-core` (wire protocol + generic dispatcher +
stdio) that both the runtime `@basaltkit/mcp` and the dev-only `@basaltkit/ai-mcp` build on, so the bridge
depends on `@basaltkit/ai` **and** `@basaltkit/mcp-core` only — **never** on `@basaltkit/mcp` (which pulls
`@basaltkit/core` + `@basaltkit/http` into the graph). Along the way, `@basaltkit/ai` must grow three
things an out-of-process consumer needs and it lacks today: **exported I/O schemas**, **streaming/progress +
cancellation threaded through the workflow engine**, and a **safe `make` preview** (clash detection + diffs)
so an agent-driven apply is safe.

---

## 1. Scope & goals

**Goals**

1. Let an MCP client (Claude Desktop, Claude Code, any agent) drive the BasaltKit dev workflow
   over stdio, using the framework's *official public APIs* only.
2. Keep the AI/codegen layer strictly **dev-only** — provably out of any app's runtime graph.
3. Model the problem in the *right* MCP primitives: tools for actions, resources for context/state,
   prompts for workflow templates.
4. Make destructive steps (`make` writes files; `--migrate` runs `prisma db push`) safe under an
   autonomous agent: preview-by-default, explicit apply, workspace scoping.
5. Sit on a mature foundation — drive the maturity work `@basaltkit/ai` and `@basaltkit/mcp` need
   rather than papering over gaps in the bridge.

**Non-goals**

- Shipping a runtime MCP capability (that is `@basaltkit/mcp`, already shipped).
- Re-implementing provider logic, planning, or codegen in the bridge — it *orchestrates* `@basaltkit/ai`.
- Remote multi-tenant hosting of the bridge (HTTP transport is a deliberate, deferred M4).

---

## A. Current-state critical review of `@basaltkit/ai`

Version `1.0.1`. Runtime deps: `@basaltkit/cli`, `@basaltkit/generator` (both `workspace:^`). Single barrel
export `.` (`packages/ai/src/index.ts`). The package is genuinely well-factored — injectable readers,
deterministic doctor rules, a hybrid generator+augment `make`. The critique below is about what an
**out-of-process bridge** needs, which is a higher bar than what the in-process CLI needs.

### A.1 Provider & model architecture — `src/provider/**`

**What's there.** `AIProvider` (`provider/types.ts`) is a tidy vendor-agnostic seam: `name`, `model`,
`generate(GenerateOptions): Promise<string>`, `stream(GenerateOptions): AsyncIterable<string>`.
`createProvider(env, { fetch })` (`provider/factory.ts`) selects `anthropic | ollama | openai(-compatible)`
from a typed `ProviderEnv`; `providerEnvFromProcess()` lifts it off `process.env`. `fetchWithRetry`
(`provider/http.ts`) retries 5xx/429 with exponential backoff. `AnthropicProvider` talks REST directly, no SDK.

**Weaknesses (ranked).**

| # | Weakness | Evidence | Impact on bridge | Fix class |
|---|----------|----------|------------------|-----------|
| 1 | `generate()` returns a **bare string** — no token usage, `finishReason`, or model echo | `provider/types.ts` `generate(): Promise<string>` | No cost/telemetry, no truncation signal to surface to the agent | **must-fix** |
| 2 | **No `AbortSignal`** anywhere (verified: 0 hits in `src/`) | — | MCP `notifications/cancelled` cannot cancel a plan/make; a runaway generation can't be stopped | **must-fix** |
| 3 | Real streaming exists only in the OpenAI-compatible provider; `AnthropicProvider`/`Ollama` fall back to `singleChunkStream` | `provider/types.ts` `singleChunkStream`, `provider/anthropic.ts` | Progressive output is uneven; can't rely on tokens for progress across providers | should-fix |
| 4 | Retry policy hardcoded (`retries=2`) and not surfaced on the provider contract | `provider/http.ts` | No per-session tuning; no jitter | could-fix |
| 5 | Errors are untyped `Error(string)` — auth vs rate-limit vs network are indistinguishable | `anthropic.ts` throws `new Error(...)` | Bridge can't map to a clean MCP error taxonomy or advise the user | should-fix |
| 6 | `google` provider throws | `factory.ts` | Cosmetic; documented | could-fix |

**Recommendation.** Introduce a richer result and a first-class streaming/cancel surface **without**
breaking the `string`-returning `generate()` (keep it as the ergonomic path):

```ts
export interface GenerateResult {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
  finishReason?: 'stop' | 'length' | 'error'
  model: string
}
export interface GenerateOptions {
  messages: AIMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal                 // (2) cancellation
  onToken?: (chunk: string) => void    // (3) uniform progressive output
}
export interface AIProvider {
  readonly name: string
  readonly model: string
  generate(options: GenerateOptions): Promise<string>          // unchanged
  generateResult?(options: GenerateOptions): Promise<GenerateResult> // new, optional
  stream(options: GenerateOptions): AsyncIterable<string>
}
export class AIProviderError extends Error {
  constructor(readonly kind: 'auth' | 'rate_limit' | 'network' | 'server' | 'bad_request', message: string) { super(message) }
}
```

### A.2 Public abstractions & contracts — `src/index.ts`

**What's exported (relevant to the bridge):** `detectProject`, `nodeReader`/`memoryReader`, `ProjectContext`
& friends; `analyze` + `AnalysisReport`; `runDoctor`/`hasErrors`, `DEFAULT_RULES`, `Diagnostic`; `createPlan`/
`parsePlan` + `ArchitecturePlan` and sub-types; `runMake` + `MakeResult`/`MakeOptions`/`ResourceBuild`;
`reviewImplementation`/`parseReview` + `AgentReview`; `createProvider`/`providerEnvFromProcess`. This is a
**good** surface — the whole workflow is callable programmatically, and the data types (`ProjectContext`,
`ArchitecturePlan`, `MakeResult`, `AnalysisReport`, `AgentReview`) are plain, serializable JSON. That is
exactly what an out-of-process bridge round-trips.

**What's missing/leaky for an out-of-process consumer:**

- **No exported runtime schemas.** `@basaltkit/ai` imports no `zod` (verified — the `zod*` names in
  `make/fields.ts` are *codegen helpers that emit zod source as strings*, not a zod dependency). `parsePlan`
  (`plan/plan.ts`) and `parseReview` (`review/review.ts`) are **hand-rolled, tolerant coercers** with no
  schema and no JSON Schema. A bridge that wants to (a) validate tool inputs, and (b) advertise MCP
  `outputSchema`/`structuredContent`, has nothing to lean on. **must-fix** — see §D.1.
- **No stable plan identity.** `runMake(ctx, plan, opts)` takes the plan object directly; the CLI creates
  and consumes it in one process (`commands.ts` `ai:make`). Across two MCP calls the client must carry the
  **entire** `ArchitecturePlan` JSON back into `make`. That works (it's serializable) but there is no
  `schemaVersion`, no content hash, and no way to say "the plan I just made". should-fix — see §D.1.
- **`createProvider` is fine but env-shaped.** It accepts an explicit `ProviderEnv` (good — the bridge can
  build one from session config, not `process.env`). No change strictly required; a
  `createProviderFromConfig(cfg)` alias would read better.

### A.3 The `analyze → plan → make → review` workflow engine

- **`analyze`** (`analyze/run.ts`) — pure over `ProjectContext`, offline, returns `AnalysisReport` (embeds
  `runDoctor`). Perfect for a read-only tool/resource.
- **`plan`** (`plan/plan.ts`) — `createPlan(provider, ctx, request)` → one `provider.generate()` with
  `BASALT_KNOWLEDGE` (`plan/knowledge.ts`) as system + `buildPlanContext(ctx)` (`plan/context.ts`, a compact
  stack summary — good "context engineering") as user. `parsePlan` normalizes. **Read-only**, fully serializable output.
- **`make`** (`make/make.ts`) — the hybrid: `generateResource()` from `@basaltkit/generator`, then augment
  (domain fields, relations/FKs, RBAC guards, audit wiring, OpenAPI meta), `writeGenerated`,
  `registerResourceInApp`, idempotent Prisma model merge, optional `prisma db push`, then a **deterministic**
  `reviewBuild` gate. `dryRun` returns the would-be `GeneratedFile[]` without writing.
- **`review`** (`review/review.ts`) — `reviewImplementation(provider, plan, result)` → LLM critique;
  `approved` is **derived from issues, not trusted from the model** (nice).

**Data model / composition strengths.** Each step's output is plain JSON; steps compose by value
(`plan → make → review`); `parseReview`/`parsePlan` never trust the model blindly.

**Weaknesses that matter for autonomous/agent use:**

| # | Weakness | Evidence | Impact | Fix class |
|---|----------|----------|--------|-----------|
| 1 | Streaming/progress **not threaded** above the provider — `createPlan`/`reviewImplementation`/`runMake` only ever call `provider.generate()` (verified: `.stream(` has 0 hits outside `provider/`) | `plan/plan.ts`, `review/review.ts` | No token/step progress to emit as MCP `notifications/progress`; long ops look frozen | **must-fix** |
| 2 | `make` **dry-run does not detect clashes** — it never calls `writeGenerated`, so preview can't tell the user which files already exist; the *only* clash signal is a write-time `FileExistsError` | `make/make.ts` `if (!options.dryRun)` branch | An agent "preview" is optimistic; safe apply needs to know the blast radius first | **must-fix** |
| 3 | Preview returns **whole-file contents**, not diffs | `ResourceBuild.files: GeneratedFile[]` | Agent must diff by hand; noisy in a chat client | should-fix |
| 4 | `--migrate` runs `prisma db push` (`make/schema.ts`, `execFile`) — a real DB mutation reachable from a non-interactive call | `make/make.ts` `mergeSchema` | Must be opt-in and never implied by a bridge default | **must-fix (policy)** |
| 5 | No cancellation → a `make` mid-write can't be aborted cleanly | — | Partial writes on cancel | should-fix |

### A.4 Architectural context system — `src/context/project.ts`

**Strengths.** `detectProject(root, reader)` is pure over an injectable `ProjectReader`
(`nodeReader`/`memoryReader`) — trivially testable, no disk needed. It detects *wired* capabilities from the
app's plugin list (`PLUGIN_TO_CAPABILITY`), parses Prisma models + `tenantScoped`, and reads app/server/env
files. `ProjectContext` is compact and serializable — an ideal MCP **resource**.

**Weakness (flag against the adapter-agnostic non-negotiable).** `DetectedStack.http` is typed
`'fastify' | null` and only `fastifyPlugin` maps to `http` in `PLUGIN_TO_CAPABILITY`. Express/Hono apps
(first-class per the "adapter-agnostic implementations" rule) are **not detected** as HTTP. The bridge will
surface this narrowness to users on non-Fastify stacks. **should-fix** — generalize detection to
`expressPlugin`/`honoPlugin` and widen the type to `'fastify' | 'express' | 'hono' | null`.

### A.5 Top-5 improvements for `@basaltkit/ai` (must-fix first)

1. **Export I/O schemas** (zod + derived JSON Schema) for `ArchitecturePlan`, `MakeResult`, `AnalysisReport`,
   `ProjectContext`, `AgentReview`; make `parsePlan`/`parseReview` validate against them. *(A.2)*
2. **Thread streaming/progress + `AbortSignal`** through `createPlan`/`reviewImplementation`/`runMake`
   (`{ signal?, onProgress? }`), so long ops can report progress and be cancelled. *(A.1#2, A.3#1)*
3. **Safe `make` preview**: detect file clashes in dry-run and emit unified diffs; keep `prisma db push`
   strictly opt-in. *(A.3#2–4)*
4. **Richer provider result + typed errors** (`GenerateResult` with usage/finishReason; `AIProviderError`
   kinds). *(A.1#1,#5)*
5. **Adapter-agnostic context detection** (express/hono, not fastify-only). *(A.4)*

---

## B. Current-state review of `@basaltkit/mcp` — what the bridge can reuse

Version `1.0.1`. Deps: `@basaltkit/core`, `@basaltkit/http`; peer `zod`.

**Reusable, clean, SDK-free (want to share, not copy):**

- **Wire protocol** — `protocol.ts`: `JsonRpcRequest/Response/Error`, `RPC_ERRORS`, `McpContent`
  (`type:'text'`), `McpToolResult` (`content` / `structuredContent` / `isError`), `ok`/`fail`/`isNotification`,
  `negotiateVersion`, `SUPPORTED_PROTOCOL_VERSIONS` (incl. `2025-06-18`). Zero framework coupling.
- **Transport-independent dispatch** — `McpServer.handleMessage()` (`server.ts`) implements `initialize`,
  `tools/list`, `tools/call`, `ping`, and swallows `notifications/{initialized,cancelled}`. The same handler
  drives HTTP and stdio.
- **Stdio loop** — `serveMcpStdio()` (`stdio.ts`): newline-delimited JSON-RPC on pure Node streams, buffered
  line framing. Generic *except* that it pulls the server via `app.container.get(MCP)`.

**The blocking coupling.** `McpServer` is **route-bound**: its only constructor path is
`collectTools(routes, container)` (`tools.ts`) over `BasaltRoute` + a DI `Container`. There is **no** API to
register an arbitrary function as an `McpTool`. So the bridge cannot reuse `McpServer` directly for
`analyze/plan/make` (which are functions, not routes) without dragging `@basaltkit/core` + `@basaltkit/http`
into a dev-only package.

**Maturity gaps (server):**

| Gap | Evidence | Needed for bridge? |
|-----|----------|--------------------|
| No **resources** (`resources/list`, `resources/read`) | `server.ts` switch | Yes — context/state as resources (§C) |
| No **prompts** (`prompts/list`, `prompts/get`) | `server.ts` switch | Yes — workflow templates (§C) |
| Capabilities advertise only `tools:{listChanged:false}` | `initialize` handler | Yes — must advertise resources/prompts/logging |
| No **progress** (`notifications/progress`, `_meta.progressToken`) | — | Yes — long plan/make ops (§C) |
| **Cancellation is a no-op** — `notifications/cancelled` is swallowed, not wired to an abort | `server.ts` | Yes — cancel a running generation |
| Only `type:'text'` content | `protocol.ts` `McpContent` | Nice-to-have (resource links) |
| **Client drops server→client notifications** — `StdioClientTransport.onData` ignores ids it isn't waiting on | `client.ts` | Yes for the E2E test harness (progress) |

**Reuse verdict.** Reuse `protocol.ts` and the stdio framing; **do not** reuse the route-bound `McpServer`
as-is. Resolve both by extracting a shared **`@basaltkit/mcp-core`** (below), which is also the boundary fix.

---

## The load-bearing decision — dependency direction & the boundary

Three ways for the bridge to get a wire protocol:

| Option | Bridge depends on | Pros | Cons | Verdict |
|--------|-------------------|------|------|---------|
| **A. Depend on `@basaltkit/mcp`** | `@basaltkit/ai` + `@basaltkit/mcp` | No new package; reuse everything | Drags `@basaltkit/core` + `@basaltkit/http` + `zod` into a **dev-only** package; couples the dev tool to runtime-framework versions; `McpServer` is route-bound and doesn't fit function tools | ✗ |
| **B. Extract `@basaltkit/mcp-core` (zero-dep)** | `@basaltkit/ai` + `@basaltkit/mcp-core` | Clean boundary — no framework in the dev graph; one wire implementation shared by runtime + dev; generic tool/resource/prompt registry fits both | One refactor of `@basaltkit/mcp` to sit on the core | ✅ **recommended** |
| **C. Vendor a slim JSON-RPC core in the bridge** | `@basaltkit/ai` only | Fastest bootstrap; zero coupling | Duplicates protocol logic — two places to fix a wire/spec bug | ✅ **as the M0 stopgap only** |

**Decision.** Target **B**. Extract `@basaltkit/mcp-core` — a **zero-runtime-dependency** package holding:
`protocol.ts` (verbatim), a **generic** `McpServer`/dispatcher that accepts arbitrary tool/resource/prompt
*registries* (not routes), the stdio transport, and the progress/cancellation plumbing. Then:

- `@basaltkit/mcp` (runtime) refactors to build its route-tools on top of `mcp-core` — its public API is unchanged.
- `@basaltkit/ai-mcp` (dev) depends on **`@basaltkit/mcp-core` + `@basaltkit/ai`** — and **never** on
  `@basaltkit/mcp`, so no `@basaltkit/core`/`@basaltkit/http` ever enters the dev-only graph.

**Dependency direction (must hold):**

```
@basaltkit/ai-mcp  ──▶ @basaltkit/ai        (public barrel API only)
        │          ──▶ @basaltkit/mcp-core  (wire protocol + generic server + stdio)
@basaltkit/mcp     ──▶ @basaltkit/mcp-core  (+ core/http, runtime)
```
No arrow ever points *into* `@basaltkit/ai-mcp`. `@basaltkit/ai` and `@basaltkit/mcp` must **never** import it.

If the maintainer wants to avoid the `mcp-core` extraction in the first milestone, ship **C** (vendor
`protocol.ts` + a ~150-line stdio dispatcher inside `ai-mcp`) and converge on **B** later — the bridge's
public surface (the bin + tool schemas) is identical either way, so this is a reversible internal choice.

---

## C. Design of `@basaltkit/ai-mcp`

### C.1 Purpose & the enforced dev-only guarantee

`@basaltkit/ai-mcp` is a **command-line MCP server** an MCP client spawns per workspace. It exposes
`@basaltkit/ai`'s workflows to agents. It is **dev-only**, enforced by construction:

1. **No runtime deps on the framework** — only `@basaltkit/ai` + `@basaltkit/mcp-core`. (`@basaltkit/ai` is
   itself already dev-only; the "AI is dev-only, not runtime" rule extends transitively.)
2. **Bin-only entry.** Consumed as `npx @basaltkit/ai-mcp` or a `devDependency`; the package's job is the
   `basalt-ai-mcp` executable. It does **not** publish a barrel that any runtime package could import.
3. **No runtime package re-exports it.** Add a CI guard (§D.4): assert no `packages/*` package (except the
   bridge itself) lists `@basaltkit/ai` or `@basaltkit/ai-mcp` in `dependencies` (only `devDependencies`).
   `create-basalt` may wire it as a `devDependency` + MCP config, never a runtime import.

### C.2 Transport — stdio primary

| Transport | When | Rationale | Milestone |
|-----------|------|-----------|-----------|
| **stdio** | Local dev; Claude Desktop/Code launch the server as a child process, injecting per-workspace `cwd` + `env` | The universal local-agent transport; the MCP client owns process lifecycle and secret injection; matches `serveMcpStdio`'s existing shape | **M1 (primary)** |
| **HTTP (Streamable)** | Remote/CI, shared team server | Reuse `mcp-core` dispatcher behind a neutral handler; needs auth/session — deliberately deferred | M4 (optional) |

Rationale for stdio-first: the bridge writes files and reads provider keys; a **local process scoped to one
workspace with keys from the launching client's `env`** is the safe default. HTTP re-opens auth/tenancy/secret
questions that don't exist locally.

### C.3 Tool surface

Five tools mirror the `basalt ai:*` CLI. Names are snake_case, agent-friendly, prefixed `basalt_`.

| Tool | Provider? | Writes? | Long-running? | Maps to |
|------|-----------|---------|---------------|---------|
| `basalt_analyze` | no | no | no | `detectProject` + `analyze` |
| `basalt_doctor` | no | no | no | `runDoctor` (+ `planFix` preview) |
| `basalt_plan` | **yes** | no | **yes** | `createPlan` |
| `basalt_make` | optional* | **yes (apply mode)** | **yes** | `runMake` |
| `basalt_review` | **yes** | no | **yes** | `reviewImplementation` |

\* `basalt_make` accepts *either* a `plan` (from a prior `basalt_plan`) *or* a `request` (in which case it
plans internally, needing a provider).

**Input/output schemas** (illustrative — the canonical ones come from `@basaltkit/ai`'s exported zod schemas, §D.1):

```jsonc
// basalt_analyze — read-only, offline
"inputSchema":  { "type":"object", "properties": { "workspaceRoot": {"type":"string"} } }
"outputSchema": { /* AnalysisReport: capabilities[], installed[], database, models[],
                     tenantScopedModels[], unscopedModels[], diagnostics[] */ }

// basalt_plan — needs a provider; long-running
"inputSchema": {
  "type":"object", "required":["request"],
  "properties": {
    "request":       {"type":"string", "description":"What to build, in natural language"},
    "workspaceRoot": {"type":"string"},
    "temperature":   {"type":"number"},
    "maxTokens":     {"type":"integer"}
  }
}
"outputSchema": { /* ArchitecturePlan: request, summary, entities[], steps[],
                     permissions[], auditEvents[], tenantScoped, warnings[],
                     schemaVersion  <-- see §D.1 */ }

// basalt_make — the one that writes; preview by default
"inputSchema": {
  "type":"object",
  "properties": {
    "plan":          { /* ArchitecturePlan, from basalt_plan */ },
    "request":       {"type":"string", "description":"Alternative to plan: plan then make in one call"},
    "workspaceRoot": {"type":"string"},
    "mode":          {"type":"string","enum":["preview","apply"],"default":"preview"},
    "force":         {"type":"boolean","default":false, "description":"Overwrite clashing files"},
    "migrate":       {"type":"boolean","default":false, "description":"Run `prisma db push` (DB mutation)"}
  },
  "oneOf": [ {"required":["plan"]}, {"required":["request"]} ]
}
"outputSchema": { /* MakeResult + a `preview` block: perFile { path, status:
                     "create"|"clash"|"skip", unifiedDiff }, and `applied: boolean` */ }
```

**Step correlation.** `basalt_plan` returns the full `ArchitecturePlan` JSON (add a `schemaVersion`). The
agent passes that object straight into `basalt_make.plan`. This keeps the bridge **stateless** — no
server-side plan store, no session affinity, trivially restart-safe. (A `planId`/hash is optional sugar; see
§F.) `basalt_review` likewise takes `{ plan, makeResult }`.

**`make` safety model — the core of the design.**

- **Preview by default.** `mode:"preview"` maps to `runMake(..., { dryRun:true })` **plus** the new clash
  detection (§D.1): the response's `preview.perFile[]` reports `create | clash | skip` and a unified diff per
  file. Nothing is written. This is the *only* thing an agent can do without an explicit second step.
- **Explicit apply.** `mode:"apply"` is required to write. Even then, files that would clash are **refused**
  unless `force:true` (mirrors `FileExistsError` semantics in `make/make.ts`).
- **DB mutation is doubly-gated.** `migrate:true` is required to run `prisma db push`, and it is never a
  default. The bridge should surface it as a follow-up in the preview, not perform it implicitly.
- **Workspace scoping.** Every write is confined to `workspaceRoot` (→ `runMake({ baseDir })`); the bridge
  rejects `workspaceRoot` outside the launch `cwd` subtree.
- **Confirmation.** Prefer MCP **elicitation** (ask the client to confirm apply) where the client supports it;
  otherwise the preview→apply two-call handshake *is* the confirmation (the agent must consciously escalate
  `mode`). The CLI's `io.confirm(...)` (`commands.ts`) has no analog over stdio — elicitation/two-call replaces it.

### C.4 Beyond tools — resources & prompts

**Resources** (read-only reflections of workspace state — a natural fit for `ProjectContext`/`AnalysisReport`,
which are already pure serializable JSON):

| URI | Backed by | Why a resource, not a tool |
|-----|-----------|----------------------------|
| `basalt://project/context` | `detectProject(root)` → `ProjectContext` | Ambient state the agent reads repeatedly; no side effects, no args beyond workspace |
| `basalt://project/analysis` | `analyze(ctx)` → `AnalysisReport` | Same; a snapshot the client can subscribe to |
| `basalt://project/diagnostics` | `runDoctor(ctx)` | Read-only findings feed the agent's reasoning |
| `basalt://knowledge/architecture` | `BASALT_KNOWLEDGE` (`plan/knowledge.ts`) | The framework conventions the planner is grounded in — exposing them lets the agent reason *with the same rules* |

Rationale: resources are for **context the agent pulls**, tools are for **actions the agent takes**. Project
state and framework knowledge are context; `plan`/`make` are actions.

**Prompts** (workflow templates — parameterized message starters):

| Prompt | Args | Expands to |
|--------|------|-----------|
| `plan-feature` | `request` | Guides the `analyze → plan → (preview) make → review` loop with the safety rules baked in |
| `scaffold-resource` | `name`, `fields?` | A focused single-entity build |
| `harden-tenancy` | — | "Run doctor, then propose fixes for tenancy findings" |
| `add-rbac` | `resource` | Wire permissions/guards for an existing resource |

Rationale: prompts encode the *intended* multi-step workflow (esp. "preview before apply") so even a naive
agent follows the safe path.

### C.5 Long-running operations

- **Progress.** `plan`/`make`/`review` accept a client `_meta.progressToken`; the bridge emits
  `notifications/progress` at phase boundaries (`planning`, `generating`, `writing`, `reviewing`) and, once
  §D.1 lands, streams model tokens via `onProgress`. Requires progress support in `mcp-core` (§D.2).
- **Streaming partial output.** Surface incremental plan text as progress messages (not final content), so the
  chat shows the plan forming; the authoritative structured result still arrives in the tool result.
- **Cancellation.** Map `notifications/cancelled` (per request id) to an `AbortController` whose signal is
  passed into `createPlan`/`runMake` (needs A.1#2 + D.1). On cancel during `make`, stop before the write
  phase; never leave a half-written resource.

### C.6 Session, workspace, config & secrets

- **Workspace.** Default `workspaceRoot = process.cwd()` (the client launches the server in the project dir);
  per-call `workspaceRoot` allowed but confined to the launch subtree.
- **Provider config.** Built from the launching process `env` via `providerEnvFromProcess()` → `createProvider`.
  A `basalt_configure` tool *may* set an in-memory session override (provider/model/temperature) — **never**
  keys, never persisted.
- **Secrets.** Provider API keys come **only** from the MCP client's `env` block (Claude config below). The
  bridge never reads, writes, or logs keys, and never ships them. Read-only tools (`analyze`/`doctor`) need no
  key at all — they run offline (matches `factory.ts`'s note that analyze/doctor never call `createProvider`).

### C.7 How it consumes `@basaltkit/ai` — and the contract it imposes back

**Consumes (public barrel only):** `detectProject`, `analyze`, `runDoctor`/`hasErrors`, `planFix`/`fixableIds`/
`applyFixEdits`, `createPlan`, `runMake`, `reviewImplementation`, `createProvider`/`providerEnvFromProcess`,
and all the exported types.

**Contract requirements the bridge imposes back on `@basaltkit/ai`** (these are the §D.1 must-fixes):

1. **Exported schemas** (zod + JSON Schema) for `ArchitecturePlan`, `MakeResult`, `AnalysisReport`,
   `ProjectContext`, `AgentReview` — for tool `inputSchema`/`outputSchema` + validation.
2. **Streaming/progress + `AbortSignal`** on `createPlan`/`runMake`/`reviewImplementation`
   (`{ signal?, onProgress? }`).
3. **Safe preview**: `runMake` dry-run must report clashes + diffs (or a dedicated `previewMake`).
4. **Serialization contract**: a `schemaVersion` on `ArchitecturePlan`/`MakeResult` so plan→make round-trips
   across processes are version-checked.
5. `prisma db push` **must** remain strictly opt-in and never a side effect of a default call.

### C.8 Packaging — bin, config, dependency graph

**Bin** (mirrors `create-basalt`'s `bin` + shebang pattern in `packages/create-app`):

```jsonc
// packages/ai-mcp/package.json (SKETCH — do not scaffold yet)
{
  "name": "@basaltkit/ai-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "basalt-ai-mcp": "./dist/bin.js" },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.build.json", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@basaltkit/ai": "workspace:^",
    "@basaltkit/mcp-core": "workspace:^"
  },
  "devDependencies": { "@basaltkit/tsconfig": "workspace:^", "@types/node": "^26.3.0",
                       "typescript": "^7.0.2", "vitest": "^4.1.11" },
  "publishConfig": { "access": "public" }
}
```

**Claude Desktop / Claude Code MCP client config** the user adds:

```jsonc
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp"],
      "cwd": "/abs/path/to/my-basalt-app",
      "env": { "AI_PROVIDER": "anthropic", "AI_API_KEY": "sk-ant-…", "AI_MODEL": "claude-sonnet-5" }
    }
  }
}
```
(Generic MCP clients: same `command`/`args`/`env`, over stdio.)

**Dependency graph:** `@basaltkit/ai-mcp → { @basaltkit/ai, @basaltkit/mcp-core }`; `@basaltkit/ai →
{ @basaltkit/cli, @basaltkit/generator }`; `@basaltkit/mcp-core → {}` (zero deps). No framework runtime
(`core`/`http`) in the bridge graph.

### C.9 Proposed package skeleton (design only)

```
packages/ai-mcp/
├── package.json
├── tsconfig.build.json
├── README.md
├── src/
│   ├── bin.ts              // #!/usr/bin/env node — parse cwd/flags, start stdio server
│   ├── index.ts            // programmatic entry: createAiMcpServer(opts) (for tests; not a runtime import)
│   ├── server.ts           // wires tools+resources+prompts into an mcp-core McpServer
│   ├── session.ts          // workspaceRoot resolution + in-memory provider/session config
│   ├── provider.ts         // buildProvider(session) via createProvider/providerEnvFromProcess
│   ├── tools/
│   │   ├── analyze.ts       // detectProject + analyze  → McpToolResult (+ structuredContent)
│   │   ├── doctor.ts        // runDoctor (+ planFix preview)
│   │   ├── plan.ts          // createPlan  (progress + signal)
│   │   ├── make.ts          // runMake preview/apply  (clash + diff + gates)
│   │   └── review.ts        // reviewImplementation
│   ├── resources/
│   │   ├── project.ts       // basalt://project/{context,analysis,diagnostics}
│   │   └── knowledge.ts     // basalt://knowledge/architecture
│   ├── prompts/
│   │   └── workflows.ts      // plan-feature, scaffold-resource, harden-tenancy, add-rbac
│   └── safety.ts            // workspace confinement, mode/force/migrate gating, diff rendering
└── test/
    ├── handshake.e2e.test.ts    // stdio initialize/list/call against a mock client
    ├── make-safety.test.ts      // preview never writes; apply gated; workspace confinement
    └── schema-conformance.test.ts
```

Key interface stubs (bridge-side):

```ts
// src/server.ts
export interface AiMcpOptions {
  cwd?: string
  input?: NodeJS.ReadableStream
  output?: { write(chunk: string): unknown }
  env?: NodeJS.ProcessEnv          // provider config source (defaults to process.env)
}
export function createAiMcpServer(opts?: AiMcpOptions): { close(): void }

// src/tools/make.ts
export type MakeMode = 'preview' | 'apply'
export interface MakeToolInput {
  plan?: ArchitecturePlan
  request?: string
  workspaceRoot?: string
  mode?: MakeMode            // default 'preview'
  force?: boolean            // default false
  migrate?: boolean          // default false
}

// A generic tool descriptor from @basaltkit/mcp-core (function tools, not routes)
export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  invoke(args: Record<string, unknown>, ctx: ToolInvokeContext): Promise<McpToolResult>
}
export interface ToolInvokeContext {
  signal: AbortSignal
  progress?: (p: { message?: string; progress?: number; total?: number }) => void
  elicit?: (prompt: string) => Promise<boolean>
}
```

---

## D. Maturity proposals (so both foundations are solid)

### D.1 `@basaltkit/ai` (the bridge's floor)

1. Add `@basaltkit/ai/schema` (or barrel exports): zod schemas + `toJsonSchema()` for `ArchitecturePlan`,
   `MakeResult`, `AnalysisReport`, `ProjectContext`, `AgentReview`; route `parsePlan`/`parseReview` through them.
2. `{ signal?: AbortSignal; onProgress?(evt) }` on `createPlan`/`runMake`/`reviewImplementation`; thread
   `signal` into `provider.generate` and (for real streaming) `provider.stream`.
3. `runMake` dry-run: detect clashes (stat vs `writeGenerated` target paths) and attach unified diffs; add
   `MakeResult.preview.perFile[]`. Keep `prisma db push` opt-in.
4. `GenerateResult` (usage/finishReason/model) + `AIProviderError` taxonomy.
5. Add `schemaVersion` to `ArchitecturePlan`/`MakeResult`. Generalize context detection to express/hono.

### D.2 `@basaltkit/mcp` + new `@basaltkit/mcp-core`

1. **Extract `@basaltkit/mcp-core`** (zero deps): `protocol.ts`, a **generic** `McpServer` that accepts
   `{ tools: McpToolDef[]; resources?: McpResourceDef[]; prompts?: McpPromptDef[] }` registries, the stdio
   transport, and progress/cancel plumbing. Refactor `@basaltkit/mcp` to build route-tools onto it (public
   API unchanged).
2. Add `resources/list`+`resources/read`, `prompts/list`+`prompts/get`, and advertise them in `initialize`
   capabilities.
3. Add `notifications/progress` emission (+ `_meta.progressToken` intake) and **real cancellation**
   (`notifications/cancelled` → per-request `AbortController`).
4. Fix `StdioClientTransport` to surface server→client notifications (progress) instead of dropping them —
   needed by the E2E harness and by real clients.
5. Typed error taxonomy over `RPC_ERRORS` (keep tool failures riding in `isError` content, per current design).

---

## E. Phased implementation plan

| Milestone | Deliverable | Depends on |
|-----------|-------------|-----------|
| **M0 — Foundations** | Either (B) extract `@basaltkit/mcp-core`, or (C) vendor a slim core in the bridge. Land `@basaltkit/ai` §D.1(1) schemas + (5) `schemaVersion`. | — |
| **M1 — Read-only bridge (stdio)** | `basalt-ai-mcp` bin; `basalt_analyze`, `basalt_doctor` tools; `basalt://project/*` + `knowledge/architecture` resources; initialize/list/call over stdio. No provider, no writes. | M0 |
| **M2 — Provider workflows** | `basalt_plan`, `basalt_review`; provider from `env`; §D.1(2) streaming/progress + cancel; `notifications/progress` in `mcp-core`. | M1, D.1(2), D.2(3) |
| **M3 — Safe `make`** | `basalt_make` preview/apply; §D.1(3) clash+diff; mode/force/migrate gates; workspace confinement; elicitation/two-call confirm. | M2, D.1(3) |
| **M4 — Prompts + polish (optional HTTP)** | `plan-feature`/`scaffold-resource`/… prompts; `create-basalt` dev-dep + MCP config wiring; optional HTTP transport. | M3 |

**Risks & mitigations**

| Risk | Mitigation |
|------|-----------|
| Autonomous agent applies destructive `make`/`migrate` | Preview-default; `mode:"apply"` + `force`/`migrate` explicit; workspace confinement; prompts encode the safe loop |
| Dev-only boundary erodes over time | CI guard (§D.4) fails the build if any runtime package depends on `@basaltkit/ai`/`ai-mcp`; zero-dep `mcp-core` keeps `core`/`http` out of the bridge graph |
| `@basaltkit/ai` schema churn breaks the bridge | `schemaVersion` + published zod schemas + a conformance test pinning the contract |
| Provider key leakage | Keys only via client `env`; bridge never logs/persists them; read-only tools need none |
| `mcp-core` extraction destabilizes runtime `@basaltkit/mcp` | Keep `@basaltkit/mcp` public API byte-identical; its existing tests are the regression gate; land core behind them |

**Testing strategy**

- **Unit:** each tool over `memoryReader`/in-memory `ProjectContext` (no disk, no network — the injectable
  reader already enables this); `make` safety (preview writes nothing; apply refuses clashes without `force`;
  `workspaceRoot` escape rejected); mock `AIProvider` for plan/review.
- **Protocol conformance:** golden `initialize` (capabilities incl. resources/prompts), `tools/list`,
  `resources/list`, `prompts/list`, error codes; a `schema-conformance` test asserting tool
  `inputSchema`/`outputSchema` match `@basaltkit/ai`'s exported JSON Schemas.
- **E2E stdio handshake:** drive the real bin with a mock client (reuse a fixed `StdioClientTransport`, §D.2(4))
  through `initialize → tools/list → basalt_analyze → basalt_plan(mock provider) → basalt_make(preview)`;
  assert progress notifications and cancellation.

### D.4 The dev-only CI guard (concrete)

A test that reads every `packages/*/package.json` and asserts `@basaltkit/ai` and `@basaltkit/ai-mcp` appear
**only** in `devDependencies` (never `dependencies`, never `peerDependencies`), except within the `ai`/`ai-mcp`
packages themselves. This makes the "AI is dev-only, not runtime" rule mechanically enforced.

---

## F. Decisions for the maintainer

| # | Decision | Options | Recommended default |
|---|----------|---------|---------------------|
| 1 | **Boundary implementation** | (A) depend on `@basaltkit/mcp`; (B) extract zero-dep `@basaltkit/mcp-core`; (C) vendor a slim core in the bridge | **B** as the target; **C** acceptable for M0 to unblock, converge on B. Never A. |
| 2 | **`make` confirmation model** | (a) preview→apply two-call handshake; (b) MCP elicitation; (c) both | **(c)** — elicitation when the client supports it, two-call handshake always as the floor; apply/force/migrate never defaulted |
| 3 | **Plan↔make correlation** | (a) stateless — client carries full `ArchitecturePlan`; (b) server-side plan store keyed by `planId` | **(a)** stateless + `schemaVersion`; add an optional content hash. A store is a later nicety, not M-critical |
| 4 | **Versioning/coupling with `@basaltkit/ai`** | (a) lockstep; (b) independent semver + `schemaVersion` contract | **(b)** — independent semver (matches the monorepo model) with a versioned schema contract + conformance test |
| 5 | **HTTP transport scope** | (a) stdio only; (b) stdio + optional HTTP | **(b)** but defer HTTP to M4; stdio is the only M1–M3 transport |
| 6 | **Bridge as `basalt` sub-CLI too?** | (a) standalone bin only; (b) also `basalt mcp:serve-ai` via `aiCommands()` | **(a)** standalone `basalt-ai-mcp` bin for M1; consider (b) later for discoverability |

---

## Appendix — source anchors (verified)

- Workflow engine: `packages/ai/src/{analyze/run,plan/plan,make/make,review/review}.ts`; barrel `packages/ai/src/index.ts`.
- Provider seam: `packages/ai/src/provider/{types,factory,anthropic,http}.ts` — `generate()` returns `string`;
  no `AbortSignal` (0 hits); `.stream(` unused above the provider layer (0 hits); `@basaltkit/ai` imports no
  `zod` (the `zod*` names in `make/fields.ts` emit zod *source strings*).
- Context: `packages/ai/src/context/project.ts` — injectable `ProjectReader`; `DetectedStack.http` is
  `'fastify' | null` (fastify-only detection).
- CLI conventions: `packages/cli/src/command.ts` (`CommandIo.confirm`), `packages/ai/src/commands.ts`
  (`ai:make` uses `io.confirm`, `--dry-run`/`--yes`/`--migrate`).
- MCP wire/transport: `packages/mcp/src/{protocol,server,stdio,tools,client}.ts` — `McpServer` built only from
  `collectTools(routes, container)`; `serveMcpStdio` pure-streams; no resources/prompts/progress; cancellation
  swallowed; client drops non-matching notification ids.
- Bin pattern: `packages/create-app/package.json` (`bin`) + `packages/create-app/src/cli.ts` (`#!/usr/bin/env node`).
