---
'@basaltkit/mcp': minor
---

BK-083: a `/mcp` session opened by a request authenticated with a userless API key is now bound to that key (`ctx().apiKey.id`, in its tenant). Before, such callers carry no `ctx().user` and no `Authorization` header when the key travels in `x-api-key`, so every one of them bound to the same anonymous fingerprint and a leaked `mcp-session-id` was accepted for a different key. A session is now refused (404) for another key or for an anonymous caller. Sessions opened by a user are unchanged; the key is read by duck-typing, with no new dependency.
