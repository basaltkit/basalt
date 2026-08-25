# What's new in Basalt 1.4

> *"Basalt 1.4" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.4 is a foundations-and-hardening release: it modernizes the toolchain,
puts real teeth back into the quality and security gates, and graduates the AI
surface to a stable 1.0.

## Highlights

### TypeScript 7 toolchain
- **The whole monorepo compiles, type-checks and tests on the TypeScript 7 native
  compiler.** Every package's build moved from `tsup` to plain `tsc` — dropping
  `rollup-plugin-dts`, which is incompatible with the TS 7 compiler — with no change
  to the published `exports`/`types` contracts. Linting stays on its supported
  TypeScript until `typescript-eslint` ships TS 7 support.

### AI & MCP → 1.0
- **`@basaltkit/ai` 1.0** — the dev-only AI developer experience: a provider-agnostic
  engine plus the `basalt ai` CLI (`analyze`, `doctor`, `plan`, `make`, `review`),
  now under a stable public API. It stays dev-only — never a runtime dependency of
  your app. *(`@basaltkit/ai` 1.0)*
- **`@basaltkit/mcp` 1.0** — the runtime Model Context Protocol surface: expose
  opt-in routes as tools over **HTTP (any adapter)** or **stdio**, and consume
  external MCP servers as a client — all through the neutral route pipeline, no
  external SDK. *(`@basaltkit/mcp` 1.0)*

### Quality gate
- **The coverage gate is enforced again.** It had gone informational; it now blocks
  regressions, scoped to unit-testable runtime code (dev-only CLI tooling and
  live-infra drivers are out of scope). Real aggregate at re-baseline: statements
  93% · branches 85% · functions 91% · lines 95%.

### Security hardening
- **Every runtime-reachable ReDoS finding is eliminated.** Quadratic
  trailing-character strips were rewritten as linear, non-regex trims across
  `audit`, `tenancy`, `mailer`, `auth`, `sdk` and `search-elasticsearch`, and the
  PII redactor length-bounds its input before matching — each with a regression test
  that proves a pathological input returns promptly. The code-scanning backlog is at
  **zero open alerts**. *(security-fix releases across the affected packages)*

## Upgrading

Packages are independent — bump only what you use; ranges are semver, so a `1.x`
minor is a drop-in and `@basaltkit/ai` / `@basaltkit/mcp` reach their first stable
`1.0`. There are no breaking runtime changes in this wave: the toolchain move is
internal, and the security fixes preserve existing behaviour (all trailing-character
stripping and email detection behave exactly as before, just without the quadratic
backtracking).
