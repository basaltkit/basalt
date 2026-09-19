---
'@basaltkit/mcp': major
---

Security: the stdio MCP client no longer passes the host's full `process.env` (APP_SECRET, DATABASE_URL, provider keys) to spawned MCP servers. By default only a non-secret allowlist (`DEFAULT_INHERITED_ENV`: PATH, HOME, locale, temp dirs and Windows basics) is inherited, plus the explicit `env`. Use `inheritEnv: ['NAME', …]` to pass extra variables, or `inheritEnv: true` to opt back in to the full environment. New export `buildStdioEnv`.
