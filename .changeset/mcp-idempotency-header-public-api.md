---
'@basaltkit/http': minor
'@basaltkit/mcp': patch
---

`@basaltkit/http` exports `idempotencyHeaderOf(container): string | undefined` — the request header `idempotencyPlugin` reads the key from, lower-cased (`'idempotency-key'` unless renamed with `idempotencyPlugin({ header })`), or `undefined` when the plugin is not registered. It reads the registration as it is now and caches nothing.

`@basaltkit/mcp` now learns the idempotency header through this helper instead of reading `@basaltkit/http`'s internal metadata, so http can change how it stores the stage without breaking tool calls. Behaviour is unchanged: a tool call still never forwards `Idempotency-Key` (always dropped) or the configured custom header. `@basaltkit/http` stays a regular dependency of `@basaltkit/mcp` (not a peer); this release publishes the range as `^2.8.0`, the http minor that adds the helper, and npm installs both together — no peer-dependency change and nothing to do for apps.
