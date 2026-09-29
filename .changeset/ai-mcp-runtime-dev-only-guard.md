---
"@basaltkit/ai-mcp": minor
---

Enforce "dev-only" at runtime and confine every tool's `workspaceRoot`.

- **Breaking:** the server refuses to start when `NODE_ENV=production` (`AiMcpProductionError`, exported; the bin prints it and exits `1`, `createAiMcpHttpServer` rejects with it). Only an explicit `production` refuses — MCP clients launch the bin without `NODE_ENV`. Override deliberately with `--allow-production`, `allowProduction: true` or `BASALT_AI_MCP_ALLOW_PRODUCTION=1`. New exports: `assertDevOnly`, `AiMcpProductionError`, `ALLOW_PRODUCTION_ENV`, `WorkspaceEscapeError`.
- **Breaking:** `basalt_analyze`, `basalt_doctor` and `basalt_plan` no longer accept an arbitrary absolute `workspaceRoot`. It must resolve inside the server's project root (`--cwd`), lexically and after symlink resolution; anything else returns a `Refused: … is outside the project root` tool error (and `resolveWorkspaceRoot` throws `WorkspaceEscapeError`). Relative roots now resolve against the project root.
