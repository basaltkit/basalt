---
"@machize/fastify": minor
---

OpenAPI (M3): `openapiPlugin` serves an OpenAPI 3.0 document generated from the
app's registered routes and their Zod schemas — no duplicate annotations. Adds
`generateOpenApi()` and a minimal `zodToJsonSchema()` (common Zod subset →
JSON Schema). Point Swagger UI / Redoc at `/openapi.json`.
