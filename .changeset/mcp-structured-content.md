---
'@basaltkit/mcp': patch
---

Fix `tools/call` results for handlers that return a top-level array or primitive:
`structuredContent` is now only set when the value is a JSON object (a record),
per the MCP spec. Arrays/primitives ride in the text `content` only (with the
full JSON), so clients no longer reject the result with "expected record,
received array".
