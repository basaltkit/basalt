---
'@basaltkit/activity': patch
'@basaltkit/activity-prisma': patch
'@basaltkit/activity-sqlite': patch
'@basaltkit/admin': patch
'@basaltkit/admin-react': patch
'@basaltkit/admin-shadcn': patch
'@basaltkit/ai': patch
'@basaltkit/ai-mcp': patch
'@basaltkit/api-keys-ui': patch
'@basaltkit/audit': patch
'@basaltkit/audit-prisma': patch
'@basaltkit/audit-sqlite': patch
'@basaltkit/audit-viewer': patch
'@basaltkit/auth': patch
'@basaltkit/auth-prisma': patch
'@basaltkit/auth-saml': patch
'@basaltkit/auth-sqlite': patch
'@basaltkit/billing-ui': patch
'@basaltkit/cache': patch
'@basaltkit/cache-tiered': patch
'@basaltkit/cli': patch
'@basaltkit/comments': patch
'@basaltkit/comments-prisma': patch
'@basaltkit/comments-sqlite': patch
'@basaltkit/config': patch
'@basaltkit/core': patch
'@basaltkit/dashboard': patch
'@basaltkit/env': patch
'@basaltkit/events': patch
'@basaltkit/events-prisma': patch
'@basaltkit/events-sqlite': patch
'@basaltkit/exports': patch
'@basaltkit/exports-xlsx': patch
'@basaltkit/express': patch
'@basaltkit/fastify': patch
'@basaltkit/files': patch
'@basaltkit/flags': patch
'@basaltkit/generator': patch
'@basaltkit/hono': patch
'@basaltkit/http': patch
'@basaltkit/i18n': patch
'@basaltkit/image-sharp': patch
'@basaltkit/logger': patch
'@basaltkit/mailer': patch
'@basaltkit/mcp': patch
'@basaltkit/mcp-core': patch
'@basaltkit/notifications': patch
'@basaltkit/notifications-prisma': patch
'@basaltkit/notifications-sqlite': patch
'@basaltkit/permissions': patch
'@basaltkit/permissions-prisma': patch
'@basaltkit/permissions-sqlite': patch
'@basaltkit/prisma': patch
'@basaltkit/queue': patch
'@basaltkit/queue-kafka': patch
'@basaltkit/queue-rabbitmq': patch
'@basaltkit/queue-sqs': patch
'@basaltkit/realtime': patch
'@basaltkit/realtime-client': patch
'@basaltkit/scheduler': patch
'@basaltkit/sdk': patch
'@basaltkit/search': patch
'@basaltkit/search-elasticsearch': patch
'@basaltkit/search-postgres': patch
'@basaltkit/storage': patch
'@basaltkit/storage-azure': patch
'@basaltkit/storage-gcs': patch
'@basaltkit/subscriptions': patch
'@basaltkit/subscriptions-pdf': patch
'@basaltkit/subscriptions-prisma': patch
'@basaltkit/subscriptions-proxypay': patch
'@basaltkit/subscriptions-sqlite': patch
'@basaltkit/teams': patch
'@basaltkit/teams-prisma': patch
'@basaltkit/teams-sqlite': patch
'@basaltkit/teams-ui': patch
'@basaltkit/tenancy': patch
'@basaltkit/tenancy-prisma': patch
'@basaltkit/tenancy-sqlite': patch
'@basaltkit/testing': patch
'@basaltkit/webhooks': patch
'@basaltkit/webhooks-prisma': patch
'@basaltkit/webhooks-sqlite': patch
'create-basalt': patch
---

Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.

Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.

- **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
- **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
- **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
