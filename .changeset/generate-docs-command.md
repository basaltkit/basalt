---
"@basaltkit/http": minor
---

Add the `generate:docs` CLI command.

`openapiPlugin` now registers a `generate:docs` command that rebuilds the OpenAPI 3.0 document from the same routes/info/tags it serves and writes it to a file (`--out=<path>`, default `openapi.json`) or stdout (`--stdout`) — without starting the HTTP server. Useful for CI, publishing, and static docs pipelines. Registered structurally into the CLI command bucket (no hard `@basaltkit/cli` dependency).
