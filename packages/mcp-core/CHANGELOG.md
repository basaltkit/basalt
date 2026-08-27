# @basaltkit/mcp-core

## 0.2.0

### Minor Changes

- 552cbe8: AI MCP bridge — M4 (prompts + polish), RFC 0001 §E. The dev-only bridge is now feature-complete per the RFC.
  
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains:
    - **Workflow prompts** (`prompts/list` + `prompts/get`): `plan-feature`, `scaffold-resource`, `harden-tenancy`, `add-rbac`. Each encodes the safe loop (analyze → plan → make **preview** → review → make apply), references the real tools/resources by name, and substitutes its arguments. The `prompts` capability is advertised.
    - **Optional HTTP transport** — an opt-in `--http[=port]` flag on the `basalt-ai-mcp` bin (and `createAiMcpHttpServer`), for remote/CI. stdio stays the default local-dev transport.
    - A **dev-only CI guard** test (RFC §D.4) asserting no workspace package lists `@basaltkit/ai` or `@basaltkit/ai-mcp` as a runtime/peer dependency.
  - **`@basaltkit/mcp-core`** adds a minimal, dependency-free **`serveHttp`** transport (pure `node:http`, no `@basaltkit/http`) — request/response JSON-RPC over `POST /mcp`. Shared by the runtime and dev servers without dragging the framework runtime into either graph.
  - **`create-basalt`** makes a `--mcp` app MCP-dev-ready: `@basaltkit/ai-mcp` is added as a **devDependency** (never a runtime dependency), a project-root `.mcp.json` registers the `basalt-ai-mcp` bridge for Claude Code/Desktop (`--cwd=.`), and the README documents the AI dev tools.
