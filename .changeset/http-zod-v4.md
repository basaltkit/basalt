---
'@basaltkit/http': patch
---

Support Zod 4 in `zodToJsonSchema` (used by OpenAPI and MCP input schemas). Zod 4
removed the v3 internals the hand-rolled converter relied on (`_def.typeName`),
so schemas produced empty `{}`. It now delegates to Zod 4's native
`z.toJSONSchema` when present and keeps the v3 path as a fallback.
