# @basaltkit/ai-mcp

A **dev-only** Model Context Protocol server that exposes Basalt's AI developer
workflows to MCP clients (Claude Desktop, Claude Code, any agent) over **stdio**.

It is a bridge, not a runtime. `@basaltkit/ai-mcp` only calls the framework's
official public APIs (`@basaltkit/ai`), and it depends solely on `@basaltkit/ai`
and the zero-dependency `@basaltkit/mcp-core` — **never** on `@basaltkit/core`,
`@basaltkit/http`, or the runtime `@basaltkit/mcp`. It must never be a runtime
dependency of your application.

> **Status: M1 (read-only).** This milestone ships `basalt_analyze` and
> `basalt_doctor` plus project/knowledge resources — no AI provider, no file
> writes. Planning, scaffolding and review (`basalt_plan` / `basalt_make` /
> `basalt_review`) arrive in M2/M3.

## Capabilities

### Tools

| Tool | What it does | Provider? | Writes? |
| --- | --- | --- | --- |
| `basalt_analyze` | Detected stack, data model and diagnostics for the project. | no | no |
| `basalt_doctor` | Diagnostics **plus a preview** of the available auto-fixes (which files each would change — computed in memory, never written). | no | no |

Both accept an optional `workspaceRoot` argument and default to the server's
workspace root. Both return `structuredContent` mirrored from the text output,
with an `outputSchema` derived from `@basaltkit/ai`'s exported schemas.

### Resources

| URI | Contents |
| --- | --- |
| `basalt://project/context` | The detected `ProjectContext` (stack, Prisma models, app/server/env files). |
| `basalt://project/analysis` | The `AnalysisReport` (capabilities, data-model summary, diagnostics). |
| `basalt://project/diagnostics` | The doctor findings. |
| `basalt://knowledge/architecture` | The BasaltKit architectural conventions the planner is grounded in. |

## Install & configure

The server is a stdio process the MCP client launches. Point it at your Basalt
project with `--cwd` (defaults to the process working directory).

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

Any client that speaks MCP over stdio: run `basalt-ai-mcp` (from a dev install)
or `npx -y @basaltkit/ai-mcp`, optionally with `--cwd=<project>`. The
read-only M1 tools need no API keys; provider keys (for M2+) will come from the
launching client's `env` block and are never shipped by this package.

## Programmatic use (tests / embedding)

```ts
import { buildAiMcpServer } from '@basaltkit/ai-mcp'

const server = buildAiMcpServer({ cwd: '/path/to/project' })
const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

`createAiMcpServer(opts)` builds the server and starts serving over stdio
(returning the transport handle). This is what the `basalt-ai-mcp` bin calls.
