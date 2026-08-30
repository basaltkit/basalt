# @basaltkit/mcp-core

## 0.3.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 0.3.0

### Minor Changes

- f197518: Harden the opt-in HTTP transport (`serveHttp`) against DNS-rebinding and CSRF.
  
  Before dispatching any JSON-RPC/tool call, `serveHttp` now validates the request's `Host` and `Origin` headers, secure-by-default:
  
  - **Host (anti-DNS-rebinding):** the `Host` hostname must be a loopback name (`localhost`, `127.0.0.1`, `::1`); a foreign `Host` (e.g. `evil.com`) is rejected with `403`.
  - **Origin (anti-CSRF):** when an `Origin` header is present it must be a loopback origin; a foreign `Origin` is rejected with `403`. Requests with no `Origin` (curl, MCP-over-HTTP clients — browsers always send `Origin` on cross-site POST) are allowed.
  - The check runs before routing, so a rejected request never reaches a tool.
  
  New optional `ServeHttpOptions` (backward-compatible; default stays loopback-only): `allowedHosts?`, `allowedOrigins?`, and a full override `allowRequest?(origin, host)` — for when you deliberately bind a non-loopback `host` (e.g. `0.0.0.0` for remote/CI). These are threaded through `@basaltkit/ai-mcp`'s `createAiMcpHttpServer`. `serveHttp`'s signature is unchanged.

## 0.2.0

### Minor Changes

- 552cbe8: AI MCP bridge — M4 (prompts + polish), RFC 0001 §E. The dev-only bridge is now feature-complete per the RFC.
  
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains:
    - **Workflow prompts** (`prompts/list` + `prompts/get`): `plan-feature`, `scaffold-resource`, `harden-tenancy`, `add-rbac`. Each encodes the safe loop (analyze → plan → make **preview** → review → make apply), references the real tools/resources by name, and substitutes its arguments. The `prompts` capability is advertised.
    - **Optional HTTP transport** — an opt-in `--http[=port]` flag on the `basalt-ai-mcp` bin (and `createAiMcpHttpServer`), for remote/CI. stdio stays the default local-dev transport.
    - A **dev-only CI guard** test (RFC §D.4) asserting no workspace package lists `@basaltkit/ai` or `@basaltkit/ai-mcp` as a runtime/peer dependency.
  - **`@basaltkit/mcp-core`** adds a minimal, dependency-free **`serveHttp`** transport (pure `node:http`, no `@basaltkit/http`) — request/response JSON-RPC over `POST /mcp`. Shared by the runtime and dev servers without dragging the framework runtime into either graph.
  - **`create-basalt`** makes a `--mcp` app MCP-dev-ready: `@basaltkit/ai-mcp` is added as a **devDependency** (never a runtime dependency), a project-root `.mcp.json` registers the `basalt-ai-mcp` bridge for Claude Code/Desktop (`--cwd=.`), and the README documents the AI dev tools.
