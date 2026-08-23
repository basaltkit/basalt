---
'@basaltkit/mcp': patch
---

Coerce stringified tool arguments to the scalar types their Zod schema declares.
MCP clients/LLMs frequently send numbers and booleans as strings; the bridge now
converts them (string → number/boolean) before validation, so routes with
`z.number()`/`z.boolean()` fields no longer reject with "expected number,
received string".
