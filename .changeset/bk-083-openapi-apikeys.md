---
'@basaltkit/http': minor
---

OpenAPI documents API keys, scopes and idempotency (BK-083 h), additively — documents of apps without `meta.scopes`, the `apiKey` option or `idempotencyPlugin` are byte-identical:

- A route with `meta.scopes` gets `security: [{ apiKeyAuth: [] }]` and an `x-required-scopes` extension listing its scopes (OpenAPI 3.0.3 allows no scopes in an `apiKey` requirement), even when `meta.auth` is set too — only a key holding the scopes passes that guard.
- `components.securitySchemes` lists only the schemes used; `apiKeyAuth` is an `apiKey` header scheme (`x-api-key` by default) whose description mentions the `Authorization: Bearer <key>` carrier, the narrow-key rule and every scope the document uses.
- `meta.auth` routes stay bearer-only unless `apiKey: { header, onAuthRoutes: true }` — opt in only when keys really pass those routes (they carry a `userId`, `apiKeysPlugin` has `users`, and they hold `*` or `allowNarrowKeysOnUnscopedRoutes` is set); `meta.apiKey: false` keeps a route bearer-only.
- `generateOpenApi(routes, info, tags?, options?)` takes new `GenerateOpenApiOptions` (`apiKey`, `idempotency`); `openapiPlugin` gains `apiKey?: { header, onAuthRoutes? } | false` and `idempotency?: false`. With `idempotencyPlugin` registered, the guarded methods document its header (original case, default `Idempotency-Key`) as an optional parameter. `generate:docs` writes the same document the plugin serves.
- `IdempotencyStage` gains a read-only `describe()` returning `{ header, methods }`.
