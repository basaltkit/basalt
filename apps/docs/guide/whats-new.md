# What's new in Basalt 1.6

> *"Basalt 1.6" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.6 is the release where **the framework guarantees what it promises**.
Three architecture review cycles took the project's stated principles — adapter
neutrality, the dev-only AI boundary, "SaaS is opt-in", secure-by-default — and
turned each one from a convention people had to remember into a **CI tripwire
that fails the build**. Along the way the reviews found, and fixed, real bugs
those principles were supposed to prevent.

## Highlights

### Promises became guarantees
Five new machine-enforced boundaries, each with a test that fails the build:
- **Adapter neutrality** — no feature package may depend on a specific HTTP
  adapter. Ten packages had drifted into importing the route contract *through*
  `@basaltkit/fastify`, forcing Fastify into Express/Hono apps; all repointed to
  `@basaltkit/http`. A cross-adapter conformance suite now runs the same neutral
  contract on all three. *(`@basaltkit/testing` gained `createTestApp({ adapter })`.)*
- **SaaS is opt-in** — a generic package may never *require* tenancy. Six had
  started to: `audit.trail()` threw on every call in a non-tenant app, pushing
  you to a method the docs call a dangerous escape hatch; `search` even required
  `tenantId` on write while reads threw. The new `apps/beyond-saas` boots a real
  app with 18 generic plugins and **no tenancy** to keep it honest.
  See [Beyond SaaS](/guide/beyond-saas).
- **The AI layer stays dev-only** — an import-graph test keeps `@basaltkit/ai`
  and `@basaltkit/ai-mcp` out of any application runtime.
- **DI lifetime safety** — the container now fails loudly on a *captive
  dependency* (a singleton that would freeze one request scope's instances
  app-wide) instead of silently serving stale objects. *(`@basaltkit/core` 1.3)*
- **Declared guards must be enforced** — a route that declares `meta.auth`,
  `can`, `teamRole`, `scopes`, `subscribed` or `feature` with no plugin to
  enforce it now **fails at boot**, naming the plugin that fixes it, instead of
  serving unprotected traffic. Opt out deliberately with `allowUnguardedMeta`.

### Security
- **Billing**: checkout/portal/invoice routes shipped **without auth** (anyone
  could open a tenant's payment portal), and `checkout()` overwrote the
  subscription so a genuinely-signed webhook could **activate an escalated
  plan**. Both fixed, with the escalation reproduced as a test first.
  *(`@basaltkit/subscriptions` 2.7)*
- **Refresh-token reuse**: `markUsed` was read-then-write, so two concurrent
  refreshes each returned a **valid** token pair. Now a compare-and-swap across
  all stores. *(`@basaltkit/auth` 1.8)*
- Stored-XSS via signed file URLs closed (`Content-Disposition: attachment` by
  default), server-rendered UIs got a **route-scoped, hash-locked CSP**, mail
  bodies are redacted in production, and `html\`\`` makes escaping the default
  path for HTML mail.

### Reliability under load
Multi-replica deployments got the guarantees they were missing: the scheduler's
`.onOneServer()` + `ScheduleLock` (no more every-replica double-runs), an event
outbox that actually honours at-least-once, RabbitMQ publisher **confirms before
ack** (closing a job-loss window), and Kafka redelivery instead of silent loss.
Five process-crash paths were eliminated — one dead WebSocket or a Redis blip
could previously take down a domain write.

### The docs are now the official reference
With API generation dropped, the guides *are* the reference: 27 guides (EN + PT)
rewritten to one didactic arc — what it is → mental model → runnable quickstart →
recipes → full options table → failure modes keyed on real error codes — and
[Core concepts](/guide/concepts) documents the internal API (container lifetimes,
plugin phases, the route pipeline, metadata buckets, writing your own
guard/enricher) well enough to build a third-party package from the docs alone.
Writing them surfaced four more real bugs.

## Upgrading

Packages are independent — bump only what you use. Two things to know:

1. **The boot check is new.** If your app declares `meta.auth` (or `can`,
   `teamRole`, `scopes`, `subscribed`, `feature`) on a route but never registers
   the enforcing plugin, it now **fails at boot** with the plugin named. That
   route was serving unprotected before; register the plugin, or opt out with
   `allowUnguardedMeta` if your edge handles it.
2. **Some defaults tightened** (documented per package): file URLs default to
   `attachment`, mail bodies are redacted in production, cache scoping fails
   closed *when tenancy is active*, and `meta.can` rejects non-string values
   instead of silently skipping the check.

---

## Previously — Basalt 1.5

> The AI developer experience **in your editor and any MCP client** — Claude
> Desktop, Claude Code, or your own — plus the TypeScript 7 move across the whole
> repository.

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

### Upgrading (1.5)

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
