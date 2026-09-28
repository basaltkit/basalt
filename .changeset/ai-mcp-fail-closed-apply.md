---
"@basaltkit/ai-mcp": minor
---

`basalt_make` apply now fails closed (framework audit FA-040), and the HTTP
transport requires a token off loopback (FA-039). Minor because the package is
0.x, where a minor is the breaking slot.

- **Breaking:** an `apply` that cannot be confirmed — the client does not
  support elicitation, or the call came over HTTP — is **refused** instead of
  writing silently. Over stdio, a client that announces the `elicitation`
  capability is now actually asked (the core wires `elicitation/create`).
  Restore the old behaviour explicitly with `--allow-unconfirmed-apply`
  (`allowUnconfirmedApply: true`).
- **Breaking:** `--http --host=<non-loopback>` is refused unless a token is
  given (`--token=<secret>` or `BASALT_AI_MCP_TOKEN`); every request must then
  send `Authorization: Bearer <secret>`. New `--allowed-hosts=a,b` accepts the
  hostnames remote clients use. Programmatic: `token`, `authorize`,
  `maxBodyBytes`, and the exported `bearerAuthorizer(token)`.
