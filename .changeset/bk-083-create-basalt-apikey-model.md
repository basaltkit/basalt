---
'create-basalt': minor
---

BK-083: `--prisma` scaffolds now emit the `@basaltkit/auth-prisma` 3.0 `AuthApiKey` model: `serviceId`, `previousHash`, `previousHashExpiresAt`, `rotatedAt`, `allowedIps`, `meta` and an index on `serviceId`. That is what API key rotation with grace, service keys and per-key IP allowlists need. A new app depends on `@basaltkit/auth-prisma ^3`; the range comes from the workspace version at build time. The existing parity test keeps the template model identical to the package's reference schema.
