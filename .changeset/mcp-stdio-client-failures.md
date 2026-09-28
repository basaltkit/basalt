---
'@basaltkit/mcp': major
---

`StdioClientTransport` no longer crashes the host or hangs forever (framework audit, Melhorias 8).

- A command that can't be spawned (`ENOENT`) emitted an unhandled `'error'` on the child process, which took down the host at boot (`mcpClientPlugin` with a mistyped command). Spawn errors, a server that exits, and `EPIPE` on its stdin now reject the calls in flight with a clear error, and the next call spawns the server again.
- New `timeoutMs` option (default 60 000 ms): a request the server never answers rejects instead of staying pending forever. Raise it for tools that legitimately run longer.
