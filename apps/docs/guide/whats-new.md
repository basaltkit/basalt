# What's new in Basalt 1.5

> *"Basalt 1.5" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.5 brings the framework's AI developer experience **into your editor and
any MCP client** — Claude Desktop, Claude Code, or your own — and finishes the
TypeScript 7 move across the whole repository.

## Highlights

### AI development over MCP
- **`@basaltkit/ai-mcp`** — a **dev-only** MCP bridge that exposes Basalt's AI
  workflows as MCP tools: `basalt_analyze`, `basalt_doctor`, `basalt_plan`,
  `basalt_review`, and a workspace-confined `basalt_make`. Point an MCP client at
  your app (`npx @basaltkit/ai-mcp --cwd=<app>`) and drive the whole
  analyze → plan → make → review loop from Claude Desktop/Code. It also ships
  **project resources** (`basalt://project/*`, `basalt://knowledge/architecture`)
  and **workflow prompts** (`plan-feature`, `scaffold-resource`, `harden-tenancy`,
  `add-rbac`), over **stdio** (default) or an opt-in **HTTP** transport. Like the
  rest of the AI surface, it is never a runtime dependency of your app.
  *(`@basaltkit/ai-mcp` 0.1)* → see [AI in your editor (MCP bridge)](/guide/ai-mcp).
- **`@basaltkit/mcp-core`** — a **zero-dependency** MCP core extracted from the
  runtime `@basaltkit/mcp`: the JSON-RPC protocol, a generic tool/resource/prompt
  server, stdio + HTTP transports, and progress/cancellation. Build your own MCP
  server on it without pulling the framework runtime into the graph; the runtime
  `@basaltkit/mcp` now sits on top of it with an unchanged public API.
  *(`@basaltkit/mcp-core` 0.3)* → see [Building an MCP server](/guide/mcp-core).
- **Safe by design.** `basalt_make` previews by default (clash detection + unified
  diffs, no writes); applying is explicit (`mode:"apply"`), overwrites need `force`,
  migrations are double-gated, and every write is confined to the target workspace.

### TypeScript 7 everywhere
- **The root now runs on TypeScript 7 too**, retiring the last `5.9` pin that
  existed only for linting — the whole repository, packages and root, is on the TS 7
  native compiler. ESLint is **temporarily paused** (a documented no-op, re-enabled
  with a one-line change) until `typescript-eslint` ships official TS 7 support;
  `typecheck` stays fully active, so real type errors are never hidden.

### Security hardening
- **The opt-in HTTP transport validates `Origin` and `Host`.** `@basaltkit/mcp-core`'s
  HTTP server already bound to loopback; it now also rejects cross-site (`Origin`)
  and DNS-rebinding (`Host`) requests, so a browser page can't drive the local dev
  bridge. Loopback-only by default, with an explicit allow-list escape hatch for
  deliberate remote/CI use. *(`@basaltkit/mcp-core` 0.3, minor)*

### Documentation
- **Exhaustive, bilingual (EN + PT) guides** for the AI/MCP dev-tooling stack:
  [AI in your editor (MCP bridge)](/guide/ai-mcp) and
  [Building an MCP server](/guide/mcp-core) — from a beginner quickstart to an
  advanced reference of every tool, resource, prompt, transport and the safe-make
  model.

## Upgrading

Packages are independent — bump only what you use. This wave is additive: the new
`@basaltkit/ai-mcp` and `@basaltkit/mcp-core` are brand-new **dev-only** tooling,
`@basaltkit/mcp`'s runtime public API is unchanged, and the TypeScript 7 root move
is internal. New Basalt apps can opt into the bridge with `create-basalt --mcp`.

---

## Previously — Basalt 1.4

> Foundations-and-hardening: it modernized the toolchain, put real teeth back into
> the quality and security gates, and graduated the AI surface to a stable 1.0.

### TypeScript 7 toolchain
- **The whole monorepo compiles, type-checks and tests on the TypeScript 7 native
  compiler.** Every package's build moved from `tsup` to plain `tsc` — dropping
  `rollup-plugin-dts`, which is incompatible with the TS 7 compiler — with no change
  to the published `exports`/`types` contracts.

### AI & MCP → 1.0
- **`@basaltkit/ai` 1.0** — the dev-only AI developer experience: a provider-agnostic
  engine plus the `basalt ai` CLI (`analyze`, `doctor`, `plan`, `make`, `review`),
  under a stable public API. *(`@basaltkit/ai` 1.0)*
- **`@basaltkit/mcp` 1.0** — the runtime Model Context Protocol surface: expose
  opt-in routes as tools over **HTTP (any adapter)** or **stdio**, and consume
  external MCP servers as a client — all through the neutral route pipeline, no
  external SDK. *(`@basaltkit/mcp` 1.0)*

### Quality gate
- **The coverage gate is enforced again.** It had gone informational; it now blocks
  regressions, scoped to unit-testable runtime code. Real aggregate at re-baseline:
  statements 93% · branches 85% · functions 91% · lines 95%.

### Security hardening
- **Every runtime-reachable ReDoS finding is eliminated.** Quadratic
  trailing-character strips were rewritten as linear, non-regex trims across
  `audit`, `tenancy`, `mailer`, `auth`, `sdk` and `search-elasticsearch`, and the
  PII redactor length-bounds its input before matching. The code-scanning backlog is
  at **zero open alerts**.
