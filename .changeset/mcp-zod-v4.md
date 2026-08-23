---
'@basaltkit/mcp': patch
---

Support Zod 4 when reading route schemas for tools. Object shapes (`_def.shape`
is now a plain object, not a function) and scalar types (`_def.type` instead of
`_def.typeName`) changed in v4, which broke tool argument splitting and the
string→number/boolean coercion. Introspection is now version-agnostic.
