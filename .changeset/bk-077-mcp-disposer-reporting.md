---
'@basaltkit/mcp': patch
---

A request disposer that fails during a tool call is reported through `reportError` (code `REQUEST_DISPOSER_FAILED`) instead of being dropped silently. Disposers still finish before the tool result is built; on a cancelled call they run once the abandoned handler has settled.
